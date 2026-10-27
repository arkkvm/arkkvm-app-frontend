/**
 * useFileDownload
 *
 * A semantic file download hook, currently based on WebRTC implementation,
 * can be extended to support HTTP downloads in the future.
 *
 * Design Goals:
 * - Avoid exposing transport details (WebRTC/HTTP), callers only care about download lifecycle events
 * - Encapsulate existing useWebRtcFile to avoid direct dependencies everywhere
 */

import { createLogger } from '@/utils/logger';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useRTCStore } from '@/stores';
import { buildRequestHeaders } from '@/api/request';
import type { RequestConfig } from '@/api/request';
import { normalizeUrl } from '@/utils/common';
import { env } from '@/utils/env';
import type { TransferSnapshot } from '@/utils/transfer';
import { calculateTransferStats } from '@/utils/transfer';
import { useCallback, useRef } from 'react';

const logger = createLogger('FileDownload');

/**
 * Download stall timeout: base 60s + 1s per MB, capped at 10 minutes.
 *
 * In cloud / poor network conditions, WebRTC DataChannel chunks may be delayed
 * by buffering, congestion, or TURN relay without the device actually stopping.
 * Scaling the timeout with expected file size prevents large downloads from
 * being aborted just because data is slow.
 */
const DOWNLOAD_STALL_TIMEOUT_BASE = 60_000;
const DOWNLOAD_STALL_TIMEOUT_MAX = 10 * 60_000;
const getDownloadStallTimeout = (totalBytes: number): number => {
  if (!totalBytes || totalBytes <= 0) return DOWNLOAD_STALL_TIMEOUT_BASE;
  const extraMs = (totalBytes / (1024 * 1024)) * 1000;
  return Math.min(DOWNLOAD_STALL_TIMEOUT_BASE + extraMs, DOWNLOAD_STALL_TIMEOUT_MAX);
};

/** Transfer task state */
export type TransferState = 'pending' | 'running' | 'paused' | 'done' | 'failed'
/** Transfer direction */
export type TransferDirection = 'upload' | 'download'

/** Transfer source */
export type TransferSource = 'virtual-usb' | 'storage'

/**
 * File transfer task - Core fields
 */
export interface TransferItem {
  path: string
  name: string
  totalBytes: number
  transferredBytes: number
  progress: number
}

/**
 * Transfer task - Runtime fields
 */
export interface TransferRuntimeFields {
  state: TransferState
  speedBps: number
  dataChannel?: string
  errorMessage?: string
  // Formatted strings
  totalFormatted?: string
  transferredFormatted?: string
  progressFormatted?: string
  speedFormatted?: string
}

/**
 * Transfer task - Persist metadata
 */
export interface TransferPersistMeta {
  id: string
  createdAt: number
  updatedAt: number
  direction?: TransferDirection
  source?: TransferSource
  deviceId?: string
}

/**
 * Download task complete structure
 * = TransferItem + TransferPersistMeta + TransferRuntimeFields
 */
export type DownloadTask = TransferItem &
  TransferPersistMeta &
  TransferRuntimeFields

/** Download task input (from caller) */
export interface DownloadFileInput {
  name: string
  path: string
  totalBytes?: number
}

/** Custom RPC initiator: receives the task and returns { dataChannel } or throws */
export type DownloadRequestFn = (
  task: DownloadTask,
  sendAsync: ReturnType<typeof useJsonRpc>[2]
) => Promise<{ dataChannel: string }>

/**
 * HTTP download initiator: receives the task and returns the download URL,
 * or throws on failure. The hook will trigger a browser <a> download.
 */
export type HttpDownloadFn = (task: DownloadTask) => Promise<string>

/**
 * Build the full URL for an HTTP-stream download given a base URL and task.
 * Default: `${baseUrl}?path=<path>&name=<name>`
 */
export type HttpBuildUrlFn = (baseUrl: string, task: DownloadTask) => string

/** useFileDownload options */
export interface UseFileDownloadOptions {
  maxConcurrency?: number
  /**
   * Transport layer for the download.
   * - `'webrtc'` (default): file is streamed via WebRTC DataChannel.
   * - `'http'`: file is downloaded via a URL (browser native download).
   */
  transport?: 'webrtc' | 'http' | 'http-stream'
  /**
   * (webrtc only) Override the RPC call used to start a download.
   * Defaults to `startFtFsDownload` when not provided.
   */
  requestDownload?: DownloadRequestFn
  /**
   * (webrtc only) Filter which incoming DataChannels this hook should handle.
   * Defaults to channels whose label starts with `tf_download_`.
   */
  channelFilter?: (label: string) => boolean
  /**
   * (http only) Resolve the download URL for a task.
   * Must be provided when transport is `'http'`.
   */
  httpDownload?: HttpDownloadFn
  /**
   * (http-stream only) Base URL for the download endpoint, e.g. `/ft/file`.
   * The full URL is constructed by `httpBuildUrl` (default: `?path=&name=`).
   * Must be provided when transport is `'http-stream'`.
   */
  httpDownloadUrl?: string
  /**
   * (http-stream only) Custom URL builder. Defaults to appending `?path=&name=`.
   */
  httpBuildUrl?: HttpBuildUrlFn
  onStart?: (task: DownloadTask) => void | Promise<void>
  onProgress?: (task: DownloadTask) => void | Promise<void>
  onComplete?: (task: DownloadTask) => void | Promise<void>
  onError?: (task: DownloadTask, error?: unknown) => void | Promise<void>
}
/** Generate task ID */
export const generateTaskId = (name: string, path: string) =>
  `${path}/${name}`.replace('//', '/');

export function useFileDownload(opts: UseFileDownloadOptions = {}) {
  const peerConnection = useRTCStore(s => s.peerConnection);
  const {
    onStart,
    onProgress,
    onComplete,
    onError,
    maxConcurrency = 3,
    transport = 'webrtc',
    requestDownload,
    channelFilter,
    httpDownload,
    httpDownloadUrl,
    httpBuildUrl,
  } = opts;

  // RPC
  const [, , sendAsync] = useJsonRpc();
  // Internal state
  const tasksRef = useRef<Map<string, DownloadTask>>(new Map());
  // Concurrency control
  const runningCountRef = useRef(0);
  const pendingQueueRef = useRef<DownloadTask[]>([]);
  // WebRTC channel mapping
  const channelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  // Receive buffers (stored by dataChannel label)
  const buffersRef = useRef<Map<string, ArrayBuffer[]>>(new Map());
  // Channel metadata mapping (dataChannel label -> task id)
  const channelTaskMapRef = useRef<Map<string, string>>(new Map());
  // Speed calculation snapshots (one per task)
  const snapshotsRef = useRef<Map<string, TransferSnapshot>>(new Map());
  // Stall timers for WebRTC downloads (one per task id)
  const stallTimersRef = useRef<Map<string, number>>(new Map());
  // Whether listener is registered
  const listenerAddedRef = useRef(false);
  // AbortControllers for in-flight http-stream downloads (keyed by task id)
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // =====================================================
  // Concurrency Queue Processing
  // =====================================================

  // =====================================================
  // HTTP-Stream download helper
  // =====================================================
  const runHttpStreamDownload = useCallback(
    async (task: DownloadTask) => {
      if (!httpDownloadUrl) {
        throw new Error('httpDownloadUrl is required when transport is \'http-stream\'');
      }

      const defaultBuildUrl: HttpBuildUrlFn = (base, t) =>
        normalizeUrl(`${env.apiBaseUrl}${base}?path=${encodeURIComponent(t.path)}&name=${encodeURIComponent(t.name)}`);
      const buildUrl = httpBuildUrl ?? defaultBuildUrl;
      const url = buildUrl(httpDownloadUrl, task);

      const controller = new AbortController();
      abortControllersRef.current.set(task.id, controller);

      task.state = 'running';
      task.updatedAt = Date.now();
      onStart?.(task);

      let receivedBytes = 0;
      const chunks: Uint8Array[] = [];

      try {
        // HEAD first to get Content-Length (totalBytes may be 0 at this point)
        let totalBytes = task.totalBytes;
        if (!totalBytes) {
          try {
            const headRes = await fetch(url, {
              method: 'HEAD',
              signal: controller.signal,
              ...buildRequestHeaders({} as RequestConfig),
            });
            const cl = headRes.headers.get('Content-Length');
            if (cl) totalBytes = parseInt(cl, 10);
          } catch {
            // HEAD failed — proceed without totalBytes
          }
        }
        task.totalBytes = totalBytes;
        task.updatedAt = Date.now();

        const { headers } = buildRequestHeaders({} as RequestConfig);
        const res = await fetch(url, {
          signal: controller.signal,
          headers,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        // Prefer Content-Length from GET response
        const clGet = res.headers.get('Content-Length');
        if (clGet) task.totalBytes = parseInt(clGet, 10);

        const reader = res.body?.getReader();
        if (!reader) throw new Error('ReadableStream not supported');

        let prevSnapshot: import('@/utils/transfer').TransferSnapshot | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) break;

          chunks.push(value.slice());
          receivedBytes += value.byteLength;
          task.transferredBytes = receivedBytes;
          task.updatedAt = Date.now();

          const currentSnapshot: import('@/utils/transfer').TransferSnapshot = {
            transferredBytes: receivedBytes,
            totalBytes: task.totalBytes,
            timestampMs: performance.now(),
            direction: 'download',
          };
          const stats = calculateTransferStats(prevSnapshot, currentSnapshot, {
            smoothingAlpha: 0.3,
            prevSmoothedSpeedBps: task.speedBps,
          });
          prevSnapshot = currentSnapshot;

          task.progress = stats.progress;
          task.speedBps = stats.speedBps;
          task.totalFormatted = stats.totalFormatted;
          task.transferredFormatted = stats.transferredFormatted;
          task.progressFormatted = stats.progressFormatted;
          task.speedFormatted = stats.speedFormatted;

          onProgress?.(task);
        }

        if (controller.signal.aborted) {
          task.state = 'failed';
          task.errorMessage = 'Aborted';
          task.updatedAt = Date.now();
          onError?.(task, new Error('Aborted'));
          return;
        }

        // Save file
        const blob = new Blob(chunks as BlobPart[]);
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = task.name;
        a.rel = 'noopener noreferrer';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
        }, 100);

        task.state = 'done';
        task.progress = 100;
        task.transferredBytes = task.totalBytes || receivedBytes;
        task.updatedAt = Date.now();
        onComplete?.(task);
      } finally {
        abortControllersRef.current.delete(task.id);
      }
    },
    [httpDownloadUrl, httpBuildUrl, onStart, onProgress, onComplete, onError]
  );

  const processQueue = useCallback(async () => {
    while (
      runningCountRef.current < maxConcurrency &&
      pendingQueueRef.current.length > 0
    ) {
      const task = pendingQueueRef.current.shift();
      if (!task) break;

      runningCountRef.current++;

      try {
        if (transport === 'http-stream') {
          // HTTP streaming download with real-time progress
          try {
            await runHttpStreamDownload(task);
          } catch (err) {
            task.state = 'failed';
            task.errorMessage = err instanceof Error ? err.message : String(err);
            task.updatedAt = Date.now();
            onError?.(task, err);
          }
          runningCountRef.current--;
          processQueue();
        } else if (transport === 'http') {
          // HTTP download: resolve URL then trigger browser native download
          if (!httpDownload) {

            throw new Error('httpDownload option is required when transport is "http"');
          }
          task.state = 'running';
          task.updatedAt = Date.now();
          onStart?.(task);

          const url = await httpDownload(task);
          const a = document.createElement('a');
          a.href = url;
          a.download = task.name;
          a.rel = 'noopener noreferrer';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            // Only revoke object URLs (blob:), not remote URLs
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          }, 100);

          task.state = 'done';
          task.progress = 100;
          task.updatedAt = Date.now();
          onComplete?.(task);
          runningCountRef.current--;
          processQueue();
        } else {
          // WebRTC download: call device RPC then wait for DataChannel
          let dataChannel: string | undefined;
          if (requestDownload) {
            const r = await requestDownload(task, sendAsync);
            dataChannel = r.dataChannel;
          } else {
            const {success,result,error} = await sendAsync(
              {
                method: 'startFtFsDownload',
                params: { path: task.path, name: task.name },
              },
              { showUnhandledErrorToast: true }
            );
            if (!success) {
              task.state = 'failed';
              task.errorMessage = String(error);
              task.updatedAt = Date.now();
              runningCountRef.current--;
              onError?.(task, error);
              processQueue();
              continue;
            }
            dataChannel = result?.dataChannel;
          }

          if (dataChannel) {
            // Request succeeded, waiting for device to create datachannel
            task.state = 'running';
            task.dataChannel = dataChannel;
            task.updatedAt = Date.now();
            onStart?.(task);
            rearmStallTimer(task.id);
          } else {
            // RPC succeeded but no dataChannel, mark as failed
            task.state = 'failed';
            task.errorMessage = 'No dataChannel returned from device';
            task.updatedAt = Date.now();
            runningCountRef.current--;
            onError?.(task, new Error('No dataChannel'));
            // Continue processing next task in queue
            processQueue();
          }
        }
      } catch (err) {
        task.state = 'failed';
        task.errorMessage = err instanceof Error ? err.message : String(err);
        task.updatedAt = Date.now();
        runningCountRef.current--;
        onError?.(task, err);
        // Continue processing next task in queue
        processQueue();
      }
    }
  }, [maxConcurrency, sendAsync, onStart, onComplete, onError, transport, requestDownload, httpDownload, runHttpStreamDownload]);

  // =====================================================
  // WebRTC DataChannel Listener
  // =====================================================

  // Per-task stall watchdog for WebRTC downloads. Slow/cloud networks can pause
  // data delivery for tens of seconds without the device actually stopping; we
  // scale the timeout with file size so large downloads are not aborted early.
  const clearStallTimer = (taskId: string) => {
    const timer = stallTimersRef.current.get(taskId);
    if (timer) {
      window.clearTimeout(timer);
      stallTimersRef.current.delete(taskId);
    }
  };

  const rearmStallTimer = (taskId: string) => {
    const task = tasksRef.current.get(taskId);
    if (!task || task.state !== 'running') return;

    clearStallTimer(taskId);
    const bytesAtArm = task.transferredBytes;
    const timeoutMs = getDownloadStallTimeout(task.totalBytes);
    const timer = window.setTimeout(() => {
      stallTimersRef.current.delete(taskId);
      const currentTask = tasksRef.current.get(taskId);
      if (!currentTask || currentTask.state !== 'running') return;

      // No bytes received for the whole stall window -> fail.
      if (currentTask.transferredBytes <= bytesAtArm) {
        currentTask.state = 'failed';
        currentTask.errorMessage = 'Download stalled: no data received for too long';
        currentTask.updatedAt = Date.now();

        const channelLabel = currentTask.dataChannel;
        if (channelLabel) {
          const channel = channelsRef.current.get(channelLabel);
          if (channel && channel.readyState === 'open') {
            try {
              channel.close();
            } catch {}
          }
          buffersRef.current.delete(channelLabel);
          channelTaskMapRef.current.delete(channelLabel);
          channelsRef.current.delete(channelLabel);
        }

        snapshotsRef.current.delete(taskId);
        tasksRef.current.delete(taskId);

        onError?.(currentTask, new Error('Download stalled: no data received for too long'));
        runningCountRef.current--;
        processQueue();
      }
    }, timeoutMs);
    stallTimersRef.current.set(taskId, timer);
  };

  const updateDownLoadFileProgress = (task: DownloadTask) => {
    // Progress update callback
    onProgress?.(task);

    // Ref useWebRtcFile: actively complete download when progress reaches 100%
    if (task.progress >= 100 && task.state === 'running') {
      const channelLabel = task.dataChannel;
      if (!channelLabel) return;

      // 1. Mark as completed
      task.state = 'done';
      task.progressFormatted = '100%';
      task.updatedAt = Date.now();

      // 2. Save file to local
      const buffers = buffersRef.current.get(channelLabel);
      if (buffers && buffers.length > 0) {
        const blob = new Blob(buffers);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = task.name;
        a.rel = 'noopener noreferrer';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);
      }

      // 3. Trigger completion callback
      onComplete?.(task);

      // 4. Close channel
      const channel = channelsRef.current.get(channelLabel);
      if (channel && channel.readyState === 'open') {
        try {
          channel.close();
        } catch (err) {
          logger.warn('Close channel error:', err);
        }
      }

      // 5. Cleanup resources (clear buffer early to release memory)
      buffersRef.current.delete(channelLabel);
      tasksRef.current.delete(task.id);
      channelTaskMapRef.current.delete(channelLabel);
      channelsRef.current.delete(channelLabel);
      snapshotsRef.current.delete(task.id);
      clearStallTimer(task.id);

      // 6. Decrement concurrency count, continue queue
      runningCountRef.current--;
      processQueue();
    }
  };
  const handleDataChannel = useCallback(
    (evt: RTCDataChannelEvent) => {
      const channel = evt.channel;
      // Only handle download channels (filtered by channelFilter or default tf_download_ prefix)
      const defaultFilter = (label: string) => label.startsWith('tf_download_');
      if (!channel || !(channelFilter ?? defaultFilter)(channel.label)) return;

      const channelLabel = channel.label;
      channelsRef.current.set(channelLabel, channel);
      // Explicitly set binaryType to arraybuffer to avoid Blob mode extra-copy overhead
      channel.binaryType = 'arraybuffer';

      channel.onmessage = (msgEvt: MessageEvent) => {
        const data = msgEvt.data;

        if (typeof data === 'string') {
          // JSON message: file metadata
          try {
            const json = JSON.parse(data);
            if (json.type === 'file_finished') {
              // File transfer completion signal
              return;
            }

            // File metadata: { name, path, size }
            const { name, path, size } = json;
            const taskId = generateTaskId(name, path);

            // Establish channel -> task mapping
            channelTaskMapRef.current.set(channelLabel, taskId);

            // Update task's dataChannel and totalBytes
            const task = tasksRef.current.get(taskId);
            if (task) {
              task.dataChannel = channelLabel;
              task.totalBytes = size;
              task.updatedAt = Date.now();
              rearmStallTimer(taskId);
            }
          } catch {}
        } else if (data instanceof ArrayBuffer) {
          // Binary data: file content
          if (!buffersRef.current.has(channelLabel)) {
            buffersRef.current.set(channelLabel, []);
          }
          buffersRef.current.get(channelLabel)!.push(data);

          // Update progress
          const taskId = channelTaskMapRef.current.get(channelLabel);
          if (taskId) {
            const task = tasksRef.current.get(taskId);
            if (task) {
              // Accumulate transferred bytes
              task.transferredBytes += data.byteLength;
              task.updatedAt = Date.now();

              // Use calculateTransferStats to calculate speed and formatted fields
              const prevSnapshot = snapshotsRef.current.get(taskId) || null;
              const currentSnapshot: TransferSnapshot = {
                transferredBytes: task.transferredBytes,
                totalBytes: task.totalBytes,
                timestampMs: performance.now(),
                direction: 'download',
              };

              const stats = calculateTransferStats(
                prevSnapshot,
                currentSnapshot,
                {
                  smoothingAlpha: 0.3,
                  prevSmoothedSpeedBps: task.speedBps,
                }
              );

              // Update task fields
              task.progress = stats.progress;
              task.speedBps = stats.speedBps;
              task.totalFormatted = stats.totalFormatted;
              task.transferredFormatted = stats.transferredFormatted;
              task.progressFormatted = stats.progressFormatted;
              task.speedFormatted = stats.speedFormatted;

              // Save snapshot for next calculation
              snapshotsRef.current.set(taskId, currentSnapshot);
              rearmStallTimer(taskId);
              updateDownLoadFileProgress(task);
            }
          }
        }
      };

      channel.onclose = () => {
        // Normal completion is handled in updateDownLoadFileProgress (progress >= 100%)
        // Only handle abnormal closure here
        const taskId = channelTaskMapRef.current.get(channelLabel);
        clearStallTimer(taskId ?? '');
        if (taskId) {
          const task = tasksRef.current.get(taskId);
          if (task && task.state === 'running') {
            task.state = 'failed';
            task.errorMessage = 'Channel closed unexpectedly';
            task.updatedAt = Date.now();

            // Release receive buffer memory immediately (mirrors upload failUpload cleanup)
            buffersRef.current.delete(channelLabel);
            tasksRef.current.delete(taskId);
            channelTaskMapRef.current.delete(channelLabel);
            channelsRef.current.delete(channelLabel);
            snapshotsRef.current.delete(taskId);

            onError?.(task, new Error('Channel closed unexpectedly'));
            runningCountRef.current--;
            processQueue();
          }
        }
      };

      channel.onerror = () => {
        const taskId = channelTaskMapRef.current.get(channelLabel);
        clearStallTimer(taskId ?? '');
        if (taskId) {
          const task = tasksRef.current.get(taskId);
          if (task) {
            task.state = 'failed';
            task.errorMessage = 'DataChannel error';
            task.updatedAt = Date.now();

            // Release receive buffer memory immediately
            buffersRef.current.delete(channelLabel);
            channelsRef.current.delete(channelLabel);
            channelTaskMapRef.current.delete(channelLabel);
            snapshotsRef.current.delete(taskId);
            tasksRef.current.delete(taskId);

            onError?.(task, new Error('DataChannel error'));
            runningCountRef.current--;
            processQueue();
          }
        }
      };
    },
    [onProgress, onComplete, onError, processQueue]
  );

  // =====================================================
  // Public API
  // =====================================================

  const downloadFile = useCallback(
    async (fileList: DownloadFileInput[]) => {
      if (!fileList || fileList.length === 0) return;

      // Register datachannel listener only for WebRTC transport (only once)
      if (transport === 'webrtc' && !listenerAddedRef.current && peerConnection) {
        peerConnection.addEventListener('datachannel', handleDataChannel);
        listenerAddedRef.current = true;
      }

      // Create tasks and add to queue
      for (const file of fileList) {
        const taskId = generateTaskId(file.name, file.path);
        // Avoid duplicate additions
        if (tasksRef.current.has(taskId)) continue;

        const task: DownloadTask = {
          // TransferItem core fields
          path: file.path,
          name: file.name,
          totalBytes: file.totalBytes || 0,
          transferredBytes: 0,
          progress: 0,
          // TransferPersistMeta persist metadata
          id: taskId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          direction: 'download',
          source: 'storage',
          // TransferRuntimeFields runtime fields
          state: 'pending',
          speedBps: 0,
        };

        tasksRef.current.set(taskId, task);
        pendingQueueRef.current.push(task);
      }

      // Start processing queue
      processQueue();
    },
    [peerConnection, handleDataChannel, processQueue]
  );

  /** Cancel download */
  const downloadFileCancel = useCallback(
    (taskId: string) => {
      const task = tasksRef.current.get(taskId);
      if (!task) return;

      clearStallTimer(taskId);

      // Abort http-stream fetch
      const abortCtrl = abortControllersRef.current.get(taskId);
      if (abortCtrl) {
        abortCtrl.abort();
        abortControllersRef.current.delete(taskId);
      }

      // close dataChannel (WebRTC)
      if (task.dataChannel) {
        const channel = channelsRef.current.get(task.dataChannel);
        if (channel) {
          try {
            channel.close();
          } catch {}
          channelsRef.current.delete(task.dataChannel);
        }
        buffersRef.current.delete(task.dataChannel);
        channelTaskMapRef.current.delete(task.dataChannel);
      }

      const wasRunning = task.state === 'running';
      task.state = 'paused';
      task.updatedAt = Date.now();

      if (wasRunning) {
        runningCountRef.current--;
        processQueue();
      }
    },
    [processQueue]
  );

  /** Get download list */
  const downloadFileList = useCallback(() => {
    return Array.from(tasksRef.current.values());
  }, []);

  return [downloadFile, downloadFileCancel, downloadFileList] as const;
}
