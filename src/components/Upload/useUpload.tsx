/**
 * Core upload hook — encapsulates all upload state, refs, and handlers.
 *
 * Supports two transport modes:
 * - **WebRTC DataChannel** (default): backpressure-controlled chunked transfer
 * - **HTTP POST** (device target with httpUploadUrl): XHR-based upload
 */
import i18n from '@/i18n';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useAppStore, useRTCStore } from '@/stores';
import { env } from '@/utils/env';
import { createLogger } from '@/utils/logger';
import { calculateTransferStats } from '@/utils/transfer';
import {
  deleteUploadTask,
  getUploadTask,
  isFileSystemAccessSupported,
  restoreFileFromHandle,
  saveUploadTask,
  updateUploadTask,
  validateFileForResume,
  type FilePickerAcceptType,
  type PersistedFileSystemFileHandle,
  type PersistedUploadStatus,
  type PersistedUploadTask,
  UploadResumeError,
} from '@/utils/uploadIndexedDb';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  CHUNK_SIZE,
  CHUNKS_PER_TICK,
  DEFAULT_HIGH_WATER_MARK,
  getAckStallTimeout,
  DEFAULT_LOW_WATER_MARK,
  FINALIZE_TIMEOUT,
  MAX_IN_FLIGHT_BYTES,
} from './constants';
import type { UploadDetail, UploadDropZoneProps, UploadState } from './types';
import { INITIAL_UPLOAD_DETAIL } from './types';
import {
  acquireUploadLock,
  dequeueNextFile,
  isUploadLocked,
  pausedFiles,
  releaseUploadLock,
  uploadQueue,
} from './uploadLock';

const logger = createLogger('Upload');

// ─── Type alias for the transfer snapshot (from @/utils/transfer) ────────
type TransferSnapshot = Parameters<typeof calculateTransferStats>[1];

/**
 * Return value of the useUpload hook.
 */
export interface UseUploadReturn {
  /** Current upload state */
  uploadState: UploadState;
  /** Real-time upload detail for progress display */
  currentUploadDetail: UploadDetail;
  /** Current file name being uploaded */
  fileName: string | null;
  /** Whether the component is in dragging state */
  dragging: boolean;
  /** Ref for the hidden file input */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Ref for file picker guard */
  pickingRef: React.MutableRefObject<boolean>;
  /** Ref to the active WebRTC DataChannel (null when idle) */
  rtcDataChannelRef: React.RefObject<RTCDataChannel | null>;
  /** Pause the current upload (closes DataChannel, emits onPause) */
  pauseUpload: () => void;
  /** Cancel the current upload (closes channel, releases lock, resets state) */
  cancelUpload: () => void;
  /** Start uploading a file */
  handleUploadStart: (file: File) => void;
  /** Resume a persisted upload task by id (File System Access API required) */
  resumeUpload: (taskId: string) => Promise<void>;
  /** Open the native file picker as a fallback when FSA resume is unavailable */
  openFilePicker: () => void;
  /** Handle drag over */
  handleDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Handle drag enter */
  handleDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Handle drag leave */
  handleDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Handle drop */
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Handle file selected from input */
  handleFileSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * Core upload hook.
 */
export function useUpload(props: UploadDropZoneProps): UseUploadReturn {
  const {
    isDragging,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onDrop,
    onFileSelected,
    onSuccess,
    onError,
    onStart,
    onProgress,
    startMethod = 'startStorageFileUpload',
    httpUploadUrl = '',
    disabled = false,
    resumeFileName,
    size: _initSize,
    totalBytes: _initTotalBytes,
    onStateChange,
    startParams,
    onPause,
    onResumeStart,
    source,
    path,
    lowWaterMark = DEFAULT_LOW_WATER_MARK,
    highWaterMark = DEFAULT_HIGH_WATER_MARK,
    maxFileSize,
    beforeUpload,
    accept,
  } = props;

  // ── File type validation helper ─────────────────────────────
  const isFileAccepted = useCallback(
    (file: File): boolean => {
      if (!accept || accept === '*') return true;
      const tokens = accept.split(',').map(t => t.trim().toLowerCase());
      const fileName = file.name.toLowerCase();
      const fileType = file.type.toLowerCase();
      return tokens.some(token => {
        if (token.startsWith('.')) {
          return fileName.endsWith(token);
        }
        if (token.includes('/')) {
          if (token.endsWith('/*')) {
            return fileType.startsWith(token.replace('/*', '/'));
          }
          return fileType === token;
        }
        return false;
      });
    },
    [accept]
  );

  // ── RTC connection ─────────────────────────────────────────
  const peerConnection = useRTCStore(s => s.peerConnection);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  useEffect(() => {
    pcRef.current = peerConnection ?? null;
  }, [peerConnection]);

  // ── Upload state ───────────────────────────────────────────
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [internalDragging, setInternalDragging] = useState(false);
  const [currentUploadDetail, setCurrentUploadDetail] =
    useState<UploadDetail>(INITIAL_UPLOAD_DETAIL);

  // ── Refs ───────────────────────────────────────────────────
  const rtcDataChannelRef = useRef<RTCDataChannel | null>(null);
  const prev = useRef(null);
  const uploadChannelLabelRef = useRef<string>('');
  const pickingRef = useRef(false);
  const startingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleUploadStartRef = useRef<(file: File) => void>(null as any);
  const pendingFilesRef = useRef<File[]>([]);
  const currentUploadedRef = useRef(0);
  const speedTimerRef = useRef<number | undefined>(undefined);
  const httpAbortRef = useRef(false);

  // ── Latest-ref for external callbacks (prevent stale closures) ──
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onResumeStartRef = useRef(onResumeStart);
  onResumeStartRef.current = onResumeStart;

  // ── Store actions ──────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerUpload = useAppStore((s: any) => s.registerUpload);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unregisterUpload = useAppStore((s: any) => s.unregisterUpload);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setUploadController = useAppStore((s: any) => s.setUploadController);
  const removeUploadController = useAppStore(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.removeUploadController
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getUploadController = useAppStore((s: any) => s.getUploadController);

  // ── JSON-RPC ───────────────────────────────────────────────
  const [, , sendAsync] = useJsonRpc(undefined, {
    showUnhandledErrorToast: true,
  });

  // ── Helpers ────────────────────────────────────────────────
  const stopSpeedMeter = useCallback(() => {
    if (speedTimerRef.current) {
      clearInterval(speedTimerRef.current);
      speedTimerRef.current = undefined;
    }
  }, []);

  const runPreUploadGuard = useCallback(
    async (file: File) => {
      if (beforeUpload) {
        try {
          const beforeUploadResult = await Promise.resolve(beforeUpload(file));
          return beforeUploadResult;
        } catch (error: unknown) {
          logger.warn('beforeUpload threw error', error);
          toast.error(error instanceof Error ? error.message : 'Upload blocked by beforeUpload');
          return false;
        }
      }

      return true;
    },
    [beforeUpload]
  );

  // ── IndexedDB persistence helpers ─────────────────────────────
  const persistUploadTask = useCallback(
    async (
      file: File,
      status: PersistedUploadStatus,
      fileHandle?: PersistedFileSystemFileHandle,
      offset = 0
    ) => {
      await saveUploadTask({
        taskId: file.name,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        uploadedBytes: offset,
        chunkSize: CHUNK_SIZE,
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: source as PersistedUploadTask['source'],
        path: path || '/',
        direction: 'upload',
        fileHandle,
      });
    },
    [source, path]
  );

  // ── Effects ────────────────────────────────────────────────

  // Reset picking guard when window regains focus (user cancels picker)
  useEffect(() => {
    const onFocus = () => {
      pickingRef.current = false;
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // If resuming and a controller with an open channel exists, attach listeners to update progress
  useEffect(() => {
    const candidates = [
      resumeFileName,
      resumeFileName ? `${resumeFileName}.incomplete` : undefined,
      fileName || undefined,
    ].filter(Boolean) as string[];
    if (!candidates.length || !getUploadController) return;
    const ctrl = candidates.map(k => getUploadController(k)).find(c => !!c);
    const ch: RTCDataChannel | undefined | null = ctrl?.channel;
    if (!ch || ch.readyState !== 'open') return;
    setUploadState('uploading');

    const onMsg = (e: MessageEvent) => {
      try {
        const { AlreadyUploadedBytes } = JSON.parse(e.data) as {
          AlreadyUploadedBytes: number;
          Size: number;
        };
        const safeUploaded = Math.max(currentUploadedRef.current || 0, AlreadyUploadedBytes || 0);

        currentUploadedRef.current = safeUploaded;
      } catch {}
    };
    ch.addEventListener('message', onMsg);
    rtcDataChannelRef.current = ch;

    return () => {
      ch.removeEventListener('message', onMsg);
      stopSpeedMeter();
    };
  }, [resumeFileName, getUploadController]);

  // Notify parent of state changes (skip initial mount)
  const onStateChangeRef = useRef<typeof onStateChange>();
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  const prevStateRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!onStateChangeRef.current) {
      prevStateRef.current = uploadState;
      return;
    }
    const prev = prevStateRef.current;
    prevStateRef.current = uploadState;
    if (prev !== undefined && prev !== uploadState) {
      onStateChangeRef.current?.(uploadState);
    }
  }, [uploadState]);

  // ── HTTP Upload Handler (chunked) ─────────────────────────
  // Each chunk: POST a 500 MiB slice as application/octet-stream.
  // Before the 2nd+ chunk, re-call RPC to get the server-confirmed offset.
  // 202 = chunk accepted, continue; 200 = upload complete.
  const HTTP_CHUNK_SIZE = 500 * 1024 * 1024; // Separate from WebRTC CHUNK_SIZE (4KB)

  const handleUploadHttp = useCallback(
    async (
      file: File,
      initialAlreadyUploadedBytes: number = 0,
      initialDataChannel: RTCDataChannel | string | null = null,
      rpcParams?: Record<string, unknown>
    ) => {
      setUploadState('uploading');

      // Track the active XHR so pause/cancel can abort it mid-chunk
      let activeXhr: XMLHttpRequest | null = null;
      let userAborted = false;
      httpAbortRef.current = false;
      let committedBytes = initialAlreadyUploadedBytes;
      let httpConfirmedBytes: number | null = null;
      let prevSmoothedSpeedBps = 0;

      // Derive initial uploadId (will be refreshed per chunk via RPC)
      const resolveUploadId = (dc: RTCDataChannel | string | null): string => {
        if (!dc) return 'http';
        if (typeof dc === 'string') return dc;
        return (dc as RTCDataChannel).label || 'http';
      };
      let currentUploadId = resolveUploadId(initialDataChannel);

      // Register controller so UI can pause/cancel
      setUploadController?.(file.name, {
        pause: () => {
          logger.info('Pause: aborting HTTP chunk upload', {
            file: file.name,
            committedBytes,
          });
          userAborted = true;
          httpAbortRef.current = true;
          try {
            activeXhr?.abort();
          } catch {}
          releaseUploadLock();
          stopSpeedMeter();
          try {
            removeUploadController?.(file.name);
          } catch {}
          setUploadState('idle');
          onPause?.({
            name: file.name,
            transferredBytes: committedBytes,
            totalBytes: file.size,
          });
          try {
            updateUploadTask(file.name, {
              status: 'paused',
              uploadedBytes: committedBytes,
              updatedAt: Date.now(),
            });
          } catch {}
          const nextFile = dequeueNextFile();
          if (nextFile) {
            setTimeout(
              () =>
                nextFile.onReady(
                  nextFile.file,
                  nextFile.channelLabel,
                  nextFile.alreadyUploadedBytes,
                  nextFile.dataChannel,
                  nextFile.rpcParams
                ),
              1000
            );
          }
        },
        resume: () => logger.warn('HTTP upload resume not supported'),
        cancel: () => {
          userAborted = true;
          try {
            activeXhr?.abort();
          } catch {}
        },
        getState: () => ({
          readyState: userAborted ? 'closed' : 'open',
        }),
      });

      // Helper: POST one chunk and return {status, responseText}
      const postChunk = (
        uploadId: string,
        blob: Blob,
        chunkOffset: number
      ): Promise<{ status: number; responseText: string }> =>
        new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          activeXhr = xhr;

          const uploadUrl = `${env.apiBaseUrl}${httpUploadUrl}?uploadId=${encodeURIComponent(uploadId)}`;
          xhr.open('POST', uploadUrl, true);
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          const csrfToken = sessionStorage.getItem('csrfToken') ?? '';
          if (csrfToken) {
            xhr.setRequestHeader('X-CSRF-Token', csrfToken);
          }

          let lastProgressEmit = 0;
          xhr.upload.onprogress = (event: ProgressEvent) => {
            const now = Date.now();
            if (now - lastProgressEmit < 200) return;
            lastProgressEmit = now;

            const current: TransferSnapshot = {
              transferredBytes: chunkOffset + event.loaded,
              totalBytes: file.size,
              timestampMs: event.timeStamp,
              direction: 'upload',
            };
            const stats = calculateTransferStats(prev.current, current, {
              smoothingAlpha: 0.3,
              prevSmoothedSpeedBps,
            });
            prevSmoothedSpeedBps = stats.speedBps;
            currentUploadedRef.current = chunkOffset + event.loaded;
            onProgressRef.current?.({ name: file.name, ...stats });
            setCurrentUploadDetail(d => ({ ...d, ...stats }));
            (prev as React.MutableRefObject<TransferSnapshot | null>).current = current;
          };

          xhr.onload = () => {
            const responseCsrfToken =
              xhr.getResponseHeader('X-CSRF-Token') || xhr.getResponseHeader('x-csrf-token');
            if (responseCsrfToken && (env.target !== 'device' ||
                (sessionStorage.getItem('csrfToken') ?? '') === csrfToken)) {
              sessionStorage.setItem('csrfToken', responseCsrfToken);
            }
            activeXhr = null;
            resolve({ status: xhr.status, responseText: xhr.responseText });
          };

          xhr.onerror = () => {
            activeXhr = null;
            if (userAborted) {
              resolve({ status: 0, responseText: '' });
            } else {
              reject(new Error(xhr.statusText || 'Network error'));
            }
          };

          xhr.onabort = () => {
            activeXhr = null;
            resolve({ status: 0, responseText: '' });
          };

          xhr.send(blob);
        });

      try {
        if (!Number.isSafeInteger(committedBytes) || committedBytes < 0 || committedBytes >= file.size) {
          throw new Error(i18n.t('common:uploadOffsetConflict'));
        }
        currentUploadedRef.current = committedBytes;

        while (committedBytes < file.size) {
          if (userAborted || httpAbortRef.current) break;

          if (committedBytes !== initialAlreadyUploadedBytes) {
            const chunkRpcParams = rpcParams ?? {
              filename: file.name,
              size: file.size,
            };
            const rpcResp = await sendAsync<'startStorageFileUpload'>(
              {
                method: startMethod as 'startStorageFileUpload',
                params: chunkRpcParams as {
                  filename: string;
                  size: number;
                },
              },
              { showUnhandledErrorToast: false, timeout: 120000 }
            );
            if (userAborted || httpAbortRef.current) break;

            if (rpcResp.success === false) {
              const rpcErr = rpcResp.error;
              const errMsg = (rpcErr?.data as string) || rpcErr?.message || 'Upload init failed';
              toast.error(errMsg);
              stopSpeedMeter();
              releaseUploadLock();
              setUploadState('failed');
              try {
                removeUploadController?.(file.name);
              } catch {}
              try {
                onErrorRef.current?.({ name: file.name, error: errMsg });
              } catch {}
              const nextFail = dequeueNextFile();
              if (nextFail) {
                setTimeout(
                  () =>
                    nextFail.onReady(
                      nextFail.file,
                      nextFail.channelLabel,
                      nextFail.alreadyUploadedBytes,
                      nextFail.dataChannel,
                      nextFail.rpcParams
                    ),
                  1000
                );
              }
              return;
            }

            const {
              alreadyUploadedBytes: serverOffset,
              dataChannel: chunkDataChannel = null,
            } = rpcResp.result || {};
            const nextUploadId = resolveUploadId(chunkDataChannel);
            // Reinitialization must agree with the last HTTP confirmation.
            // Never guess which of two conflicting device offsets is correct.
            if (typeof serverOffset !== 'number' || !Number.isSafeInteger(serverOffset) || serverOffset !== committedBytes) {
              logger.error('[upload-diagnostic] conflicting-rpc-offset', {
                serverOffset, committedBytes, nextUploadId, currentUploadId,
              });
              throw new Error(i18n.t('common:uploadOffsetConflict'));
            }
            committedBytes = serverOffset;
            currentUploadedRef.current = committedBytes;
            currentUploadId = nextUploadId;

            if (committedBytes >= file.size) break;
          }

          const chunkEnd = Math.min(committedBytes + HTTP_CHUNK_SIZE, file.size);
          const blob = file.slice(committedBytes, chunkEnd);


          const { status, responseText } = await postChunk(currentUploadId, blob, committedBytes);

          if (userAborted || httpAbortRef.current) break;

          if (status === 200 || status === 202) {
            httpConfirmedBytes = null;
            if (status === 202) {
              // Device HTTP API: { message: "Upload partial: <written>/<size>" }.
              // Parse only this documented confirmation, never arbitrary text.
              let body: unknown;
              try {
                body = JSON.parse(responseText);
              } catch {
                throw new Error(i18n.t('common:uploadConfirmationInvalid'));
              }
              const message = body && typeof body === 'object' && 'message' in body
                ? body.message : undefined;
              const match = typeof message === 'string'
                ? /^Upload partial:\s*(\d+)\/(\d+)$/.exec(message) : null;
              if (match) {
                const written = Number(match[1]);
                const total = Number(match[2]);
                if (Number.isSafeInteger(written) && total === file.size &&
                    written > committedBytes && written <= chunkEnd && written < file.size) {
                  httpConfirmedBytes = written;
                }
              }
            }
            if (status === 202 && httpConfirmedBytes === null) {
              throw new Error(i18n.t('common:uploadConfirmationInvalid'));
            }
            if (status === 200 && chunkEnd !== file.size) {
              throw new Error(i18n.t('common:uploadConfirmationInvalid'));
            }
            if (status === 200) committedBytes = file.size;
            else if (httpConfirmedBytes !== null) committedBytes = httpConfirmedBytes;
            currentUploadedRef.current = committedBytes;

            const justSentAll = committedBytes >= file.size;
            if (justSentAll) {
              setUploadState('success');
              onSuccessRef.current?.(file);
              try {
                unregisterUpload?.(file.name);
              } catch {}
              try {
                removeUploadController?.(file.name);
              } catch {}
              try {
                deleteUploadTask(file.name);
              } catch {}
              stopSpeedMeter();
              releaseUploadLock();
              const nextFile = dequeueNextFile();
              if (nextFile)
                setTimeout(
                  () =>
                    nextFile.onReady(
                      nextFile.file,
                      nextFile.channelLabel,
                      nextFile.alreadyUploadedBytes,
                      nextFile.dataChannel,
                      nextFile.rpcParams
                    ),
                  100
                );
              return;
            }
            // Intermediate chunk accepted — continue with next slice
            continue;
          } else {
            // Genuine failure
            let deviceBrief = '';
            try {
              const body = JSON.parse(responseText);
              deviceBrief = body?.error?.brief || body?.errors?.[0]?.brief || '';
            } catch {}
            const reason = deviceBrief ? `${status} — ${deviceBrief}` : `HTTP ${status}`;
            logger.error('[Upload] chunk POST failed', {
              status,
              responseText,
              file: file.name,
              committedBytes,
            });
            toast.error(`Upload failed: ${reason}`);
            stopSpeedMeter();
            releaseUploadLock();
            setUploadState('failed');
            try {
              removeUploadController?.(file.name);
            } catch {}
            try {
              onErrorRef.current?.({ name: file.name, error: reason });
            } catch {}
            const nextFail = dequeueNextFile();
            if (nextFail)
              setTimeout(
                () =>
                  nextFail.onReady(
                    nextFail.file,
                    nextFail.channelLabel,
                    nextFail.alreadyUploadedBytes,
                    nextFail.dataChannel,
                    nextFail.rpcParams
                  ),
                1000
              );
            return;
          }
        }

        // Loop exited normally (all bytes committed or server confirmed complete)
        if (!userAborted && committedBytes >= file.size) {
          setUploadState('success');
          onSuccessRef.current?.(file);
          try {
            unregisterUpload?.(file.name);
          } catch {}
          try {
            removeUploadController?.(file.name);
          } catch {}
          try {
            deleteUploadTask(file.name);
          } catch {}
          stopSpeedMeter();
          releaseUploadLock();
          const nextFile = dequeueNextFile();
          if (nextFile)
            setTimeout(
              () =>
                nextFile.onReady(
                  nextFile.file,
                  nextFile.channelLabel,
                  nextFile.alreadyUploadedBytes,
                  nextFile.dataChannel,
                  nextFile.rpcParams
                ),
              100
            );
        }
      } catch (e: unknown) {
        if (userAborted) return;
        currentUploadedRef.current = committedBytes;
        const reason = e instanceof Error ? e.message : 'Unknown error';
        logger.error('HTTP chunk upload error', { file: file.name, error: reason, committedBytes });
        toast.error(`Upload failed: ${reason}`);
        stopSpeedMeter();
        releaseUploadLock();
        setUploadState('failed');
        try {
          removeUploadController?.(file.name);
        } catch {}
        try {
          onErrorRef.current?.({ name: file.name, error: reason });
        } catch {}
        try {
          updateUploadTask(file.name, {
            status: 'failed',
            uploadedBytes: committedBytes,
            updatedAt: Date.now(),
          });
        } catch {}
        const nextErr = dequeueNextFile();
        if (nextErr)
          setTimeout(
            () =>
              nextErr.onReady(
                nextErr.file,
                nextErr.channelLabel,
                nextErr.alreadyUploadedBytes,
                nextErr.dataChannel,
                nextErr.rpcParams
              ),
            1000
          );
      }
    },
    [sendAsync, startMethod, stopSpeedMeter, httpUploadUrl]
  );

  // ── WebRTC Upload Handler ──────────────────────────────────
  const handleUploadWebRTC = useCallback(
    async (
      file: File,
      alreadyUploadedBytes: number = 0,
      dataChannelLabel: string | null = null
    ) => {
      // Clear pause marker for this file (avoid stale marker blocking re-upload of same filename)
      pausedFiles.delete(file.name);

      const pc = pcRef.current;
      logger.info('Creating upload DataChannel', {
        label: dataChannelLabel || 'upload',
        file: file.name,
        size: file.size,
        alreadyUploadedBytes,
        pcState: pc?.connectionState,
        pcIceState: pc?.iceConnectionState,
      });
      const rtcDataChannel = pc?.createDataChannel(dataChannelLabel || 'upload');
      if (!rtcDataChannel) {
        logger.error('Failed to create data channel for file upload');
        toast.error('Failed to create data channel for file upload');
        return;
      }
      rtcDataChannel.binaryType = 'arraybuffer';
      rtcDataChannelRef.current = rtcDataChannel;
      uploadChannelLabelRef.current = dataChannelLabel || rtcDataChannel.label;

      // user controlled pause flag
      const userPauseRef = { current: false } as { current: boolean };
      rtcDataChannel.bufferedAmountLowThreshold = lowWaterMark;

      // Refs shared across handlers
      const sentOffsetRef = { current: alreadyUploadedBytes } as {
        current: number;
      };
      const lastAckBytesRef = { current: alreadyUploadedBytes } as {
        current: number;
      };

      // ── Finish helpers ─────────────────────────────────────
      const finishedRef = { current: false } as { current: boolean };
      let finalizeTimer: number | undefined;
      const clearFinalizeTimer = () => {
        if (finalizeTimer) {
          clearTimeout(finalizeTimer);
          finalizeTimer = undefined;
        }
      };

      // ACK-stall watchdog: armed while the frontend has unconfirmed bytes (blocked
      // on the ACK window, or fully sent and waiting for the device). Re-armed on
      // each advancing ACK, so it fires only if the device-confirmed
      // AlreadyUploadedBytes stops growing for ACK_STALL_TIMEOUT — then we abort
      // instead of hanging forever.
      let ackStallTimer: number | undefined;
      const clearAckStallTimer = () => {
        if (ackStallTimer) {
          clearTimeout(ackStallTimer);
          ackStallTimer = undefined;
        }
      };

      const finishSuccess = () => {
        const finishIfDrained = () => {
          if (rtcDataChannel.readyState === 'closed') return;
          if (rtcDataChannel.bufferedAmount === 0) {
            try {
              rtcDataChannel.close();
            } catch {}
            finishedRef.current = true;
            releaseUploadLock();
            setUploadState('success');
            onSuccessRef.current?.(file);
            try {
              unregisterUpload?.(file.name);
            } catch {}
            try {
              deleteUploadTask(file.name);
            } catch {}
            // Process next queued file
            const nextFile = dequeueNextFile();
            if (nextFile)
              setTimeout(
                () =>
                  nextFile.onReady(
                    nextFile.file,
                    nextFile.channelLabel,
                    nextFile.alreadyUploadedBytes,
                    nextFile.dataChannel,
                    nextFile.rpcParams
                  ),
                1000
              );
            return;
          }
          requestAnimationFrame(finishIfDrained);
        };
        finishIfDrained();
      };

      // ── Failure helper (used by ACK-stall watchdog / size mismatch) ──
      const failUpload = (reason: string) => {
        if (finishedRef.current) return;
        finishedRef.current = true;
        clearFinalizeTimer();
        clearAckStallTimer();
        sendNextChunkFn = null;
        try {
          rtcDataChannel.onmessage = null;
          rtcDataChannel.onbufferedamountlow = null;
          rtcDataChannel.onerror = null;
          rtcDataChannel.onclose = null;
          if (rtcDataChannel.readyState === 'open') rtcDataChannel.close();
        } catch {}
        rtcDataChannelRef.current = null;
        stopSpeedMeter();
        releaseUploadLock();
        setUploadState('failed');
        toast.error(reason);
        onErrorRef.current?.({ name: file.name, error: reason });
        try {
          unregisterUpload?.(file.name);
        } catch {}
        try {
          removeUploadController?.(file.name);
        } catch {}
        try {
          updateUploadTask(file.name, {
            status: 'failed',
            uploadedBytes: lastAckBytesRef.current,
            updatedAt: Date.now(),
          });
        } catch {}
        const nextFail = dequeueNextFile();
        if (nextFail)
          setTimeout(
            () =>
              nextFail.onReady(
                nextFail.file,
                nextFail.channelLabel,
                nextFail.alreadyUploadedBytes,
                nextFail.dataChannel,
                nextFail.rpcParams
              ),
            1000
          );
      };

      // Hoisted to outer scope so onmessage can access them
      let waitingForAck = false;
      // True while the send loop is paused on DataChannel bufferedAmount backpressure;
      // resumed by onbufferedamountlow.
      let waitingForDrain = false;
      let sendNextChunkFn: (() => void) | null = null;

      // Arm the ACK-stall watchdog against the ACK value observed when we start waiting.
      const armAckStallTimer = () => {
        clearAckStallTimer();
        const ackAtArm = lastAckBytesRef.current;
        const stallTimeoutMs = getAckStallTimeout(file.size);
        ackStallTimer = window.setTimeout(() => {
          if (finishedRef.current || userPauseRef.current) return;
          // Only fail if we are still ahead of the device and it never advanced.
          if (
            lastAckBytesRef.current <= ackAtArm &&
            sentOffsetRef.current > lastAckBytesRef.current
          ) {
            logger.error('[Upload] ACK stalled — device stopped confirming, aborting', {
              file: file.name,
              sentBytes: sentOffsetRef.current,
              AlreadyUploadedBytes: lastAckBytesRef.current,
              stallMs: stallTimeoutMs,
            });
            failUpload('Upload timed out: device stopped confirming');
          }
        }, stallTimeoutMs);
      };

      // ── onopen: start chunked send loop ────────────────────
      rtcDataChannel.onopen = () => {
        logger.info('Upload channel opened', {
          label: rtcDataChannel.label,
          id: rtcDataChannel.id,
          protocol: rtcDataChannel.protocol,
          readyState: rtcDataChannel.readyState,
          binaryType: rtcDataChannel.binaryType,
          bufferedAmountLowThreshold: rtcDataChannel.bufferedAmountLowThreshold,
        });
        setUploadState('uploading');

        uploadChannelLabelRef.current = dataChannelLabel || rtcDataChannel.label;
        // Register upload & expose controller
        try {
          registerUpload?.(file.name, {
            filename: file.name,
            channelLabel: dataChannelLabel || rtcDataChannel.label,
            startedAt: Date.now(),
            size: file.size,
          });
          setUploadController?.(file.name, {
            pause: () => {
              logger.info('Pause: closing DataChannel to stop upload', {
                file: file.name,
                sentBytes: sentOffsetRef.current,
                channelState: rtcDataChannel.readyState,
              });
              pausedFiles.add(file.name);
              userPauseRef.current = true;

              // 1) Mark as finished to prevent duplicate onclose handling
              finishedRef.current = true;

              // 2) Clear finalize / ACK-stall timers
              clearFinalizeTimer();
              clearAckStallTimer();

              // 3) Stop send-loop reference
              sendNextChunkFn = null;

              // 4) Close DataChannel and detach listeners to prevent leaks
              try {
                rtcDataChannel.onmessage = null;
                rtcDataChannel.onbufferedamountlow = null;
                rtcDataChannel.onerror = null;
                rtcDataChannel.onclose = null;
                rtcDataChannel.close();
              } catch {}

              // 5) Clean refs
              rtcDataChannelRef.current = null;

              // 6) Stop speed meter
              try {
                stopSpeedMeter();
              } catch {}

              // 7) Release lock
              releaseUploadLock();

              // 8) Remove controller from store (release channel reference)
              try {
                removeUploadController?.(file.name);
              } catch {}

              // 9) Notify parent layer
              setUploadState('idle');
              const pausedOffset = lastAckBytesRef.current;
              onPause?.({
                name: file.name,
                transferredBytes: pausedOffset,
                totalBytes: file.size,
              });
              try {
                updateUploadTask(file.name, {
                  status: 'paused',
                  uploadedBytes: pausedOffset,
                  updatedAt: Date.now(),
                });
              } catch {}

              // 10) Dequeue next waiting file (lock already released)
              const nextPaused = dequeueNextFile();
              if (nextPaused)
                setTimeout(
                  () =>
                    nextPaused.onReady(
                      nextPaused.file,
                      nextPaused.channelLabel,
                      nextPaused.alreadyUploadedBytes,
                      nextPaused.dataChannel,
                      nextPaused.rpcParams
                    ),
                  1000
                );
            },
            resume: () => {
              logger.warn('Resume not supported after channel close');
            },
            getState: () => ({
              paused: pausedFiles.has(file.name),
              buffered: rtcDataChannel.bufferedAmount,
              readyState: rtcDataChannel.readyState,
            }),
            channel: rtcDataChannel,
          });
        } catch {}

        // ── Send state ───────────────────────────────────────
        let offset = alreadyUploadedBytes;
        currentUploadedRef.current = offset;

        // ── Chunked send loop ────────────────────────────────
        const sendNextChunk = () => {
          // All bytes sent by the frontend. This only means the local `offset`
          // (sentBytes) reached file.size — it is NOT upload success. Success is
          // decided solely by the device ACK (AlreadyUploadedBytes >= Size) in
          // onmessage/onclose. We stay in `uploading` until then (i.e. "waiting
          // for device confirmation").
          if (offset >= file.size) {
            sentOffsetRef.current = offset;
            logger.info('All bytes sent, waiting for device confirmation (ACK)', {
              file: file.name,
              sentBytes: offset,
              fileSize: file.size,
              AlreadyUploadedBytes: lastAckBytesRef.current,
              finishedRef: finishedRef.current,
            });
            // Guard against the device never sending a final ACK: watch for stall.
            if (lastAckBytesRef.current < file.size) armAckStallTimer();
            return;
          }

          // User paused
          if (pausedFiles.has(file.name) || userPauseRef.current) {
            logger.warn('[Upload] sendNextChunk blocked by pause', {
              file: file.name,
              pausedFilesHas: pausedFiles.has(file.name),
              userPauseRef: userPauseRef.current,
              offset,
              fileSize: file.size,
            });
            return;
          }

          // Channel closed
          if (rtcDataChannel.readyState !== 'open') return;

          // ── ACK sliding-window backpressure ──────────────────
          // Keep the frontend offset (sentBytes) from racing too far ahead of the
          // device-confirmed AlreadyUploadedBytes. When the gap reaches the window,
          // pause; onmessage resumes the loop once the device ACK advances.
          const inFlightBytes = offset - lastAckBytesRef.current;
          if (inFlightBytes >= MAX_IN_FLIGHT_BYTES) {
            waitingForAck = true;
            logger.warn('[Upload] waiting for ACK window', {
              file: file.name,
              offset,
              AlreadyUploadedBytes: lastAckBytesRef.current,
              inFlight: inFlightBytes,
              maxInFlight: MAX_IN_FLIGHT_BYTES,
            });
            armAckStallTimer();
            return;
          }

          // ── DataChannel buffer backpressure (browser memory) ──
          // If the send buffer is already high, wait for onbufferedamountlow to
          // drain before pushing more into it.
          if (rtcDataChannel.bufferedAmount >= highWaterMark) {
            waitingForDrain = true;
            logger.info('[Upload] buffer high, waiting for drain', {
              file: file.name,
              bufferedAmount: rtcDataChannel.bufferedAmount,
              highWaterMark,
            });
            return;
          }

          // Batch send
          let chunksThisTick = 0;
          const sendBatch = () => {
            const end = Math.min(offset + CHUNK_SIZE, file.size);
            file
              .slice(offset, end)
              .arrayBuffer()
              .then(buffer => {
                if (rtcDataChannel.readyState !== 'open') return;

                try {
                  rtcDataChannel.send(buffer);
                } catch {
                  logger.warn('send() buffer full, will retry after drain', {
                    bufferedAmount: rtcDataChannel.bufferedAmount,
                    readyState: rtcDataChannel.readyState,
                    offset,
                  });
                  const retryCurrentChunk = () => {
                    if (rtcDataChannel.readyState !== 'open') return;
                    if (pausedFiles.has(file.name) || userPauseRef.current) return;
                    try {
                      rtcDataChannel.send(buffer);
                    } catch {
                      setTimeout(retryCurrentChunk, 50);
                      return;
                    }
                    offset = end;
                    sentOffsetRef.current = offset;
                    currentUploadedRef.current = offset;
                    logger.info('[Upload] Retry succeeded, continuing', {
                      file: file.name,
                      offset,
                      fileSize: file.size,
                      done: offset >= file.size,
                    });
                    setTimeout(sendNextChunk, 0);
                  };
                  setTimeout(retryCurrentChunk, 50);
                  return;
                }
                offset = end;
                sentOffsetRef.current = offset;
                currentUploadedRef.current = offset;

                if (offset >= file.size || pausedFiles.has(file.name) || userPauseRef.current) {
                  sendNextChunk();
                  return;
                }

                chunksThisTick++;
                if (chunksThisTick < CHUNKS_PER_TICK) {
                  sendBatch();
                } else {
                  setTimeout(sendNextChunk, 0);
                }
              });
          };
          sendBatch();
        };

        sendNextChunkFn = sendNextChunk;
        sendNextChunk();
      };

      // ── onmessage: device ACK ──────────────────────────────
      // The device reports its confirmed write position via
      // { AlreadyUploadedBytes, Size }. This is the source of truth for both
      // progress and success — the frontend `offset`/sentBytes is only how far
      // we have pushed into the channel, not what the device has accepted.
      rtcDataChannel.onmessage = e => {
        try {
          const { AlreadyUploadedBytes: transferredBytes, Size: totalBytes } = JSON.parse(
            e.data
          ) as { AlreadyUploadedBytes: number; Size: number };

          if (
            finishedRef.current ||
            !Number.isSafeInteger(transferredBytes) ||
            transferredBytes < lastAckBytesRef.current ||
            transferredBytes > file.size
          ) return;

          // Size mismatch: device disagrees on the file size — abort rather than
          // report a bogus completion. (Field names AlreadyUploadedBytes / Size
          // are the backend protocol and left unchanged.)
          if (totalBytes && file.size && totalBytes !== file.size) {
            logger.error('[Upload] Size mismatch from device ACK, aborting', {
              file: file.name,
              deviceSize: totalBytes,
              fileSize: file.size,
              AlreadyUploadedBytes: transferredBytes,
            });
            failUpload('Upload aborted: device reported a different file size');
            return;
          }

          const current: TransferSnapshot = {
            transferredBytes,
            totalBytes,
            timestampMs: e.timeStamp || performance.now(),
            direction: 'upload',
          };
          const stats = calculateTransferStats(prev.current, current);
          setCurrentUploadDetail(prev => ({ ...prev, ...stats }));
          prev.current = current;
          onProgressRef.current?.({ name: file.name, ...stats });

          const ackAdvanced = transferredBytes > lastAckBytesRef.current;
          currentUploadedRef.current = transferredBytes;
          lastAckBytesRef.current = transferredBytes;

          // Keep the stall watchdog honest: on each advancing ACK, re-arm it so it
          // only ever fires when AlreadyUploadedBytes stops growing for too long.
          // Clear it outright once the device has confirmed the whole file.
          if (ackAdvanced) {
            if (totalBytes > 0 && transferredBytes >= totalBytes) {
              clearAckStallTimer();
            } else {
              armAckStallTimer();
            }
          }

          // Upload success is decided here: only when the device-confirmed
          // AlreadyUploadedBytes reaches Size. finishSuccess() still waits for the
          // channel buffer to drain / device to close before flipping to success.
          if (totalBytes > 0 && transferredBytes >= totalBytes) {
            logger.info('[Upload] Device confirmed full receipt (AlreadyUploadedBytes >= Size)', {
              file: file.name,
              AlreadyUploadedBytes: transferredBytes,
              Size: totalBytes,
              sentBytes: sentOffsetRef.current,
              fileSize: file.size,
            });
            clearAckStallTimer();
            if (finalizeTimer) clearTimeout(finalizeTimer);

            finalizeTimer = window.setTimeout(() => {
              if (!finishedRef.current) {
                finishSuccess();
              }
            }, FINALIZE_TIMEOUT);
          }

          // Resume the send loop if it was blocked on the ACK window.
          if (waitingForAck) {
            waitingForAck = false;
            if (!userPauseRef.current && !pausedFiles.has(file.name)) sendNextChunkFn?.();
          }
        } catch {}
      };

      // ── onbufferedamountlow: resume after buffer drains ────
      // Fires when bufferedAmount drops to/below bufferedAmountLowThreshold
      // (lowWaterMark). Only resumes if the send loop paused on buffer backpressure.
      rtcDataChannel.onbufferedamountlow = () => {
        if (finishedRef.current || !waitingForDrain) return;
        waitingForDrain = false;
        if (!userPauseRef.current && !pausedFiles.has(file.name)) sendNextChunkFn?.();
      };

      // ── onclose ────────────────────────────────────────────
      rtcDataChannel.onclose = () => {
        const totalSize = file.size;
        const sentBytes = sentOffsetRef.current;
        const ackedBytes = lastAckBytesRef.current;
        const buffered = rtcDataChannel.bufferedAmount;

        logger.warn('Upload channel closed', {
          file: file.name,
          totalSize,
          sentBytes,
          ackedBytes,
          buffered,
          finished: finishedRef.current,
        });

        clearFinalizeTimer();
        clearAckStallTimer();
        stopSpeedMeter();

        if (finishedRef.current) return;

        const locallyDone = sentBytes >= totalSize && totalSize > 0;
        // Success is decided by the device, not the frontend: only a device-confirmed
        // AlreadyUploadedBytes >= Size counts. A clean close after full confirmation is
        // the device's completion signal. sentBytes >= Size alone (locallyDone) only
        // means the frontend finished pushing — if the device has not confirmed, the
        // close is treated as an unexpected failure below, not success.
        const remotelyDone = ackedBytes >= totalSize && totalSize > 0;

        if (remotelyDone) {
          logger.info('[Upload] Success confirmed on close (AlreadyUploadedBytes >= Size)', {
            file: file.name,
            locallyDone,
            remotelyDone,
            sentBytes,
            AlreadyUploadedBytes: ackedBytes,
            totalSize,
            fileSize: file.size,
          });

          // If device closed the channel as its completion signal, give the final
          // disk write a brief moment before flipping UI to success.
          const delayMs = 500;

          setTimeout(() => {
            releaseUploadLock();
            setUploadState('success');
            onSuccessRef.current?.(file);
            try {
              removeUploadController?.(file.name);
            } catch {}
            const nextOk = dequeueNextFile();
            if (nextOk)
              setTimeout(
                () =>
                  nextOk.onReady(
                    nextOk.file,
                    nextOk.channelLabel,
                    nextOk.alreadyUploadedBytes,
                    nextOk.dataChannel,
                    nextOk.rpcParams
                  ),
                100
              );
          }, delayMs);
          return;
        }

        logger.error('Upload channel closed unexpectedly', {
          file: file.name,
          totalSize,
          sentBytes,
          AlreadyUploadedBytes: ackedBytes,
          buffered,
          // Common failure mode: frontend finished sending (locallyDone) but the
          // device never confirmed the full Size — the close is NOT a success.
          sentAllButUnconfirmed: locallyDone && !remotelyDone,
          progress: totalSize > 0 ? `${((ackedBytes / totalSize) * 100).toFixed(1)}%` : '0%',
        });
        releaseUploadLock();
        toast.error('Upload channel closed unexpectedly');
        setUploadState('failed');
        try {
          unregisterUpload?.(file.name);
        } catch {}
        try {
          removeUploadController?.(file.name);
        } catch {}
        const nextClose = dequeueNextFile();
        if (nextClose)
          setTimeout(
            () =>
              nextClose.onReady(
                nextClose.file,
                nextClose.channelLabel,
                nextClose.alreadyUploadedBytes,
                nextClose.dataChannel,
                nextClose.rpcParams
              ),
            1000
          );
      };

      // ── onerror ────────────────────────────────────────────
      rtcDataChannel.onerror = (event: Event) => {
        const rtcErr = (event as RTCErrorEvent)?.error;
        logger.error('RTC channel error', {
          file: file.name,
          errorDetail: rtcErr?.errorDetail,
          message: rtcErr?.message || String(event),
          sentBytes: sentOffsetRef.current,
          ackedBytes: lastAckBytesRef.current,
          channelState: rtcDataChannel.readyState,
        });
        toast.error(`Upload failed: ${rtcErr?.message || String(event)}`);
        clearFinalizeTimer();
        clearAckStallTimer();
        releaseUploadLock();
        setUploadState('failed');
        stopSpeedMeter();
        onErrorRef.current?.({ name: file.name, error: rtcErr?.message || String(event) });
        try {
          unregisterUpload?.(file.name);
        } catch {}
        try {
          removeUploadController?.(file.name);
        } catch {}
        const nextErr = dequeueNextFile();
        if (nextErr)
          setTimeout(
            () =>
              nextErr.onReady(
                nextErr.file,
                nextErr.channelLabel,
                nextErr.alreadyUploadedBytes,
                nextErr.dataChannel,
                nextErr.rpcParams
              ),
            1000
          );
      };
    },
    [sendAsync, setUploadController, removeUploadController, lowWaterMark, highWaterMark]
  );

  // ── Start upload directly (skip RPC, used by queued items) ──
  const startUploadDirect = useCallback(
    async (
      file: File,
      channelLabel: string,
      alreadyUploadedBytes: number,
      dataChannel: string | RTCDataChannel | null,
      rpcParams?: Record<string, unknown>
    ) => {
      try {
        if (!acquireUploadLock()) {
          // Edge case: lock was acquired by another upload first; requeue
          uploadQueue.push({
            file,
            channelLabel,
            alreadyUploadedBytes,
            dataChannel,
            rpcParams,
            onReady: (f, cl, ab, dc, rp) => startUploadDirectRef.current?.(f, cl, ab, dc, rp),
          });
          return;
        }

        uploadChannelLabelRef.current = channelLabel;
        try {
          registerUpload?.(file.name, {
            filename: file.name,
            channelLabel,
            startedAt: Date.now(),
          });
        } catch {}
        if (env.target === 'device' && httpUploadUrl) {
          await handleUploadHttp(file, alreadyUploadedBytes, dataChannel, rpcParams);
        } else {
          await handleUploadWebRTC(file, alreadyUploadedBytes, channelLabel);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toast.error(errMsg || 'Upload start failed');
        onErrorRef.current?.({ name: file.name, error: errMsg || 'Upload start failed' });
        releaseUploadLock();
        const next = dequeueNextFile();
        if (next)
          setTimeout(
            () =>
              next.onReady(
                next.file,
                next.channelLabel,
                next.alreadyUploadedBytes,
                next.dataChannel,
                next.rpcParams
              ),
            1000
          );
      }
    },
    [sendAsync]
  );

  const startUploadDirectRef = useRef(startUploadDirect);
  startUploadDirectRef.current = startUploadDirect;

  // ── Upload Start Orchestrator ──────────────────────────────
  // First call RPC to obtain dataChannel.
  // Register/enqueue only when channel info is valid; otherwise reject directly.
  const handleUploadStart = useCallback(
    async (file: File, fileHandle?: PersistedFileSystemFileHandle) => {
      // Check if file already exists in upload task list
      const existingController = getUploadController?.(file.name);
      if (existingController) {
        toast.warning(`File "${file.name}" is already being uploaded`);
        return;
      }

      // Clear pause marker for this file (avoid stale marker blocking same-name re-upload)
      pausedFiles.delete(file.name);

      if (startingRef.current || isUploadLocked()) {
        onStart?.({
          alreadyUploadedBytes: 0,
          dataChannel: null,
          filename: file.name,
          size: file.size,
        });
        uploadQueue.push({
          file,
          channelLabel: '',
          alreadyUploadedBytes: 0,
          dataChannel: null,
          onReady: queuedFile => handleUploadStartRef.current?.(queuedFile),
        });
        toast.info(`${file.name} queued, will start after current upload`);
        return;
      }
      startingRef.current = true;

      const passedPreUploadGuard = await runPreUploadGuard(file);
      if (!passedPreUploadGuard) {
        startingRef.current = false;
        return;
      }

      // Check file size limit
      if (maxFileSize && file.size > maxFileSize) {
        const formatSize = (bytes: number) => {
          if (bytes < 1000) return `${bytes} B`;
          if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(2)} KB`;
          if (bytes < 1000 * 1000 * 1000) return `${(bytes / (1000 * 1000)).toFixed(2)} MB`;
          return `${(bytes / (1000 * 1000 * 1000)).toFixed(2)} GB`;
        };
        toast.error(
          `File size (${formatSize(file.size)}) exceeds the maximum allowed size of ${formatSize(maxFileSize)}`
        );
        startingRef.current = false;
        return;
      }

      try {
        // 1) Call RPC first to validate and obtain channel name
        const baseParams: Record<string, unknown> = { filename: file.name, size: file.size };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let extra: any = null;

        if (typeof startParams === 'function') {
          try {
            extra = await Promise.resolve(startParams(file));
          } catch (error) {
            logger.warn('startParams threw error', error);
          }
        }

        let params = extra || { ...baseParams };

        const startResp = await sendAsync(
          {
            method: startMethod as 'startStorageFileUpload',
            params,
          },
          { showUnhandledErrorToast: false, timeout: 120000 }
        );
        if (startResp.success === false) {
          const startErr = startResp.error;
          const errMsg = (startErr?.data as string) || startErr?.message || 'Upload start failed';
          toast.error(errMsg);
          setUploadState('failed');
          onErrorRef.current?.({ name: file.name, error: errMsg });
          startingRef.current = false;
          return;
        }
        const { alreadyUploadedBytes: uploadedBytes, dataChannel = null } = startResp.result || {};
        const alreadyUploadedBytes = uploadedBytes ?? 0;

        // 2) No channel and not in HTTP mode -> reject
        const isHttpMode = env.target === 'device' && !!httpUploadUrl;
        if (!dataChannel && !isHttpMode) {
          logger.warn('No dataChannel returned from RPC, rejecting', { file: file.name });
          startingRef.current = false;
          return;
        }

        const channelLabel: string | null = dataChannel
          ? typeof dataChannel === 'string'
            ? dataChannel
            : (dataChannel as RTCDataChannel)?.label || 'upload'
          : null;

        // 3) Notify UI to create task row
        setFileName(file.name);
        onStart?.({
          alreadyUploadedBytes,
          dataChannel,
          filename: file.name,
          size: file.size,
        });

        // Persist task metadata (and file handle when available) so the upload
        // can be resumed after a page refresh. Status is 'uploading' because the
        // actual transfer starts below.
        try {
          await persistUploadTask(file, 'uploading', fileHandle, alreadyUploadedBytes);
        } catch {
          // Non-fatal: IndexedDB failures should not block the upload.
        }

        // 4) Try to acquire lock:
        //    if another upload is in progress, enqueue and reuse RPC result later

        if (!acquireUploadLock()) {
          uploadQueue.push({
            file,
            channelLabel: channelLabel || '',
            alreadyUploadedBytes,
            dataChannel,
            rpcParams: params as Record<string, unknown>,
            onReady: (f, cl, ab, dc, rp) => startUploadDirectRef.current?.(f, cl, ab, dc, rp),
          });
          toast.info(`${file.name} queued, will start after current upload`);
          // Release startingRef so pending files can continue RPC initialization
          startingRef.current = false;
          const nextQueued = pendingFilesRef.current.shift();
          if (nextQueued) {
            setTimeout(() => handleUploadStartRef.current?.(nextQueued), 50);
          }
          return;
        }

        // 5) No active task -> start upload immediately
        uploadChannelLabelRef.current = channelLabel || '';
        try {
          registerUpload?.(file.name, {
            filename: file.name,
            channelLabel,
            startedAt: Date.now(),
          });
        } catch {}

        // 6) Initialization complete: release startingRef and process pending queue
        //    so later files can run RPC and enqueue immediately
        startingRef.current = false;
        const nextPending = pendingFilesRef.current.shift();
        if (nextPending) {
          setTimeout(() => handleUploadStartRef.current?.(nextPending), 50);
        }
        if (env.target === 'device' && httpUploadUrl) {
          await handleUploadHttp(
            file,
            alreadyUploadedBytes,
            dataChannel,
            params as Record<string, unknown>
          );
        } else {
          await handleUploadWebRTC(file, alreadyUploadedBytes, channelLabel);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        toast.error(errMsg || 'Upload start failed');
        onErrorRef.current?.({ name: file.name, error: errMsg || 'Upload start failed' });
        // Ensure lock is released on exception to avoid deadlock
        releaseUploadLock();
        const nextErr = dequeueNextFile();
        if (nextErr)
          setTimeout(
            () =>
              nextErr.onReady(
                nextErr.file,
                nextErr.channelLabel,
                nextErr.alreadyUploadedBytes,
                nextErr.dataChannel,
                nextErr.rpcParams
              ),
            1000
          );
      } finally {
        // Fallback: always release startingRef (catch path or unexpected exception)
        if (startingRef.current) {
          startingRef.current = false;
          const fallbackPending = pendingFilesRef.current.shift();
          if (fallbackPending) {
            setTimeout(() => handleUploadStartRef.current?.(fallbackPending), 50);
          }
        }
      }
    },
    [beforeUpload, maxFileSize, sendAsync, startMethod, onStart, startParams, runPreUploadGuard]
  );

  // Keep a stable ref so completion handlers inside closures can call the latest version
  handleUploadStartRef.current = handleUploadStart;

  // ── Resume Upload from Persisted Task ────────────────────────
  // After a page refresh, retrieve the persisted file handle and task info,
  // re-request read permission within the user gesture, validate the file, and
  // resume the upload starting from the device-reported AlreadyUploadedBytes.
  const resumeUpload = useCallback(
    async (taskId: string) => {
      if (startingRef.current) {
        toast.info('Another upload is starting, please wait');
        return;
      }
      if (!isFileSystemAccessSupported()) {
        throw new UploadResumeError(
          'not-supported',
          'File System Access API is not available in this browser'
        );
      }

      const task = await getUploadTask(taskId);
      if (!task || !task.fileHandle) {
        throw new UploadResumeError(
          'file-missing',
          'Persisted upload task or file handle not found'
        );
      }

      // Guard against concurrent uploads for the same task.
      if (getUploadController?.(taskId)) {
        toast.info('This upload is already active');
        return;
      }

      startingRef.current = true;
      try {
        const file = await restoreFileFromHandle(task);
        const validation = validateFileForResume(task, file);
        if (!validation.valid) {
          throw new UploadResumeError(validation.reason, validation.message);
        }

        const passedPreUploadGuard = await runPreUploadGuard(file);
        if (!passedPreUploadGuard) {
          return;
        }

        // Use the same RPC entry point as an initial upload: the device is the
        // source of truth for the resume offset.
        const baseParams: Record<string, unknown> = {
          filename: file.name,
          size: file.size,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let extra: any = null;
        if (typeof startParams === 'function') {
          try {
            extra = await Promise.resolve(startParams(file));
          } catch (error) {
            logger.warn('startParams threw error', error);
          }
        }
        const params = extra || baseParams;
        const startResp = await sendAsync(
          { method: startMethod as 'startStorageFileUpload', params },
          { showUnhandledErrorToast: false, timeout: 120000 }
        );
        if (startResp.success === false) {
          const errMsg =
            (startResp.error?.data as string) || startResp.error?.message || 'Upload resume failed';
          throw new UploadResumeError('device-task-missing', errMsg);
        }

        const { alreadyUploadedBytes: uploadedBytes = 0, dataChannel = null } =
          startResp.result || {};
        const alreadyUploadedBytes = uploadedBytes ?? 0;
        if (alreadyUploadedBytes > file.size) {
          throw new UploadResumeError(
            'offset-invalid',
            'Device reported an offset larger than the file size'
          );
        }

        const channelLabel: string | null = dataChannel
          ? typeof dataChannel === 'string'
            ? dataChannel
            : (dataChannel as RTCDataChannel)?.label || 'upload'
          : null;
        const isHttpMode = env.target === 'device' && !!httpUploadUrl;
        if (!dataChannel && !isHttpMode) {
          throw new UploadResumeError('unknown', 'No upload channel returned from device');
        }

        setFileName(file.name);
        onResumeStartRef.current?.({
          alreadyUploadedBytes,
          dataChannel,
          filename: file.name,
          size: file.size,
          taskId,
        });

        await updateUploadTask(taskId, {
          status: 'uploading',
          uploadedBytes: alreadyUploadedBytes,
          updatedAt: Date.now(),
        });

        // Reuse the existing chunked transfer engine, starting from the
        // device-confirmed offset.
        await startUploadDirectRef.current?.(
          file,
          channelLabel || '',
          alreadyUploadedBytes,
          dataChannel,
          params as Record<string, unknown>
        );
      } catch (err: unknown) {
        if (err instanceof UploadResumeError) {
          throw err;
        }
        throw new UploadResumeError('unknown', err instanceof Error ? err.message : String(err));
      } finally {
        startingRef.current = false;
      }
    },
    [sendAsync, startMethod, startParams, httpUploadUrl, runPreUploadGuard]
  );

  // ── Drag & Drop Handlers ───────────────────────────────────
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof isDragging !== 'boolean') setInternalDragging(true);
    onDragOver?.(e);
  };
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof isDragging !== 'boolean') setInternalDragging(true);
    onDragEnter?.(e);
  };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof isDragging !== 'boolean') setInternalDragging(false);
    onDragLeave?.(e);
  };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof isDragging !== 'boolean') setInternalDragging(false);
    const dt = e.dataTransfer;
    const files = dt?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!isFileAccepted(file)) {
          toast.error(`Unsupported file type: ${file.name}. Accepted: ${accept}`);
          continue;
        }
        if (onFileSelected) {
          onFileSelected(file);
        } else {
          handleUploadStart(file);
        }
      }
    }
    onDrop?.(e);
  };

  const dragging = typeof isDragging === 'boolean' ? isDragging : internalDragging;

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    const files = e.target.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!isFileAccepted(file)) {
          toast.error(`Unsupported file type: ${file.name}. Accepted: ${accept}`);
          continue;
        }
        if (onFileSelected) {
          onFileSelected(file);
        } else {
          handleUploadStart(file);
        }
      }
      e.currentTarget.value = '';
    }
    pickingRef.current = false;
  };

  // ── External Control Methods ─────────────────────────────
  const pauseUpload = useCallback(() => {
    if (!fileName) return;
    const ctrl = getUploadController?.(fileName) || getUploadController?.(`${fileName}.incomplete`);
    if (ctrl?.pause) {
      ctrl.pause();
    } else {
      logger.warn('No upload controller found for pause', { fileName });
    }
  }, [fileName, getUploadController]);

  const cancelUpload = useCallback(() => {
    const ch = rtcDataChannelRef.current;
    if (ch) {
      try {
        ch.onmessage = null;
        ch.onbufferedamountlow = null;
        ch.onerror = null;
        ch.onclose = null;
        if (ch.readyState === 'open') ch.close();
      } catch {}
    }
    rtcDataChannelRef.current = null;
    releaseUploadLock();
    stopSpeedMeter();
    setUploadState('idle');
    if (fileName) {
      try {
        unregisterUpload?.(fileName);
      } catch {}
      try {
        removeUploadController?.(fileName);
      } catch {}
    }
  }, [fileName, stopSpeedMeter, unregisterUpload, removeUploadController]);

  return {
    uploadState,
    currentUploadDetail,
    fileName,
    dragging,
    inputRef,
    pickingRef,
    rtcDataChannelRef,
    pauseUpload,
    cancelUpload,
    handleUploadStart,
    resumeUpload,
    openFilePicker: () => {
      if (disabled) return;
      if (pickingRef.current) return;

      const buildPickerTypes = (): FilePickerAcceptType[] => {
        if (!accept || accept === '*') return [];
        const types: FilePickerAcceptType[] = [];
        const extensions: string[] = [];
        const mimeTypes: string[] = [];
        accept.split(',').forEach(token => {
          const t = token.trim().toLowerCase();
          if (!t) return;
          if (t.startsWith('.')) {
            extensions.push(t);
          } else if (t.includes('/')) {
            mimeTypes.push(t);
          }
        });
        if (extensions.length) {
          types.push({
            description: 'Allowed files',
            accept: { 'application/octet-stream': extensions },
          });
        }
        mimeTypes.forEach(mime => {
          types.push({ description: 'Allowed files', accept: { [mime]: [] } });
        });
        return types;
      };

      if (!isFileSystemAccessSupported()) {
        pickingRef.current = true;
        inputRef.current?.click();
        return;
      }

      pickingRef.current = true;
      void (async () => {
        try {
          const showPicker = (
            window as unknown as {
              showOpenFilePicker?: (
                options?: Record<string, unknown>
              ) => Promise<FileSystemFileHandle[]>;
            }
          ).showOpenFilePicker;
          if (!showPicker) throw new Error('showOpenFilePicker not available');
          const handles = await showPicker({
            multiple: true,
            types: buildPickerTypes(),
          });
          pickingRef.current = false;
          for (const handle of handles) {
            const file = await handle.getFile();
            await handleUploadStart(file, handle as unknown as PersistedFileSystemFileHandle);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            pickingRef.current = false;
            return;
          }
          logger.warn('FSA picker failed, falling back to input', e);
          inputRef.current?.click();
        }
      })();
    },
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleFileSelected,
  };
}
