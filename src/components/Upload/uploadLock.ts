/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2026-02-09 20:49:31
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-02-27 16:26:29
 */
/**
 * Module-level upload lock & queue.
 *
 * Persists across component remounts and instances to ensure
 * only one file uploads at a time via WebRTC DataChannel.
 */
import { createLogger } from '@/utils/logger';
import { useAppStore } from '@/stores';
import { UPLOAD_LOCK_TIMEOUT } from './constants';

const logger = createLogger('UploadLock');

// ── Global upload lock ──────────────────────────────────────
let _globalUploading = false;
let _globalUploadingTimestamp = 0;

// ── Global upload queue ─────────────────────────────────────
export interface QueuedFile {
  file: File
  /** Channel label obtained from the initial RPC call */
  channelLabel: string
  /** Bytes already uploaded (for resume) */
  alreadyUploadedBytes: number
  /** Original dataChannel value from RPC (string or object) */
  dataChannel: string | RTCDataChannel | null
  /** Extra RPC params (e.g. path) needed by per-chunk startXxx calls in HTTP mode */
  rpcParams?: Record<string, unknown>
  /** Callback to start upload directly (skips RPC) */
  onReady: (file: File, channelLabel: string, alreadyUploadedBytes: number, dataChannel: string | RTCDataChannel | null, rpcParams?: Record<string, unknown>) => void
}
export const uploadQueue: QueuedFile[] = [];

// ── Module-level pause markers to avoid closure-scope issues ──
export const pausedFiles = new Set<string>();

/**
 * Safely acquire upload lock.
 * Automatically releases stale lock when timeout is reached
 * or when no active task is running.
 *
 * @returns `true` if lock acquired, `false` if another upload is in progress
 */
export function acquireUploadLock(): boolean {

  if (_globalUploading) {
    const timedOut = Date.now() - _globalUploadingTimestamp > UPLOAD_LOCK_TIMEOUT;

    // Check whether controllers contain an active DataChannel via controller.getState()
    const controllers = useAppStore.getState().controllers || {};
    const hasActiveUpload = Object.values(controllers).some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctrl: any) => ctrl?.getState?.()?.readyState === 'open'
    );

    if (timedOut || !hasActiveUpload) {
      logger.warn('[Upload] Force releasing stale upload lock', {
        timedOut,
        hasActiveUpload,
        controllerCount: Object.keys(controllers).length,
        queueLength: uploadQueue.length,
      });
      _globalUploading = false;
      // Keep queue intact; queued files are still valid and should continue
    } else {
      return false; // Lock is still valid and an active channel exists
    }
  }
  _globalUploading = true;
  _globalUploadingTimestamp = Date.now();
  return true;
}

/**
 * Release upload lock.
 */
export function releaseUploadLock(): void {
  _globalUploading = false;
  _globalUploadingTimestamp = 0;
}

/**
 * Dequeue next file waiting for upload.
 *
 * @returns Next queued item, or `undefined` if queue is empty
 */
export function dequeueNextFile(): QueuedFile | undefined {
  return uploadQueue.shift();
}

/**
 * Remove queued file by filename.
 *
 * @returns `true` if the file was found and removed
 */
export function removeFromQueue(filename: string): boolean {
  const idx = uploadQueue.findIndex(q => q.file.name === filename);
  if (idx !== -1) {
    uploadQueue.splice(idx, 1);
    return true;
  }
  return false;
}

/**
 * Get all queued files (read-only copy).
 *
 * @returns Array of queued files
 */
export function getQueuedFiles(): ReadonlyArray<QueuedFile> {
  return [...uploadQueue];
}

/**
 * Clear all queued files.
 */
export function clearQueue(): void {
  uploadQueue.length = 0;
}

/**
 * Check if upload lock is currently held.
 */
export function isUploadLocked(): boolean {
  return _globalUploading;
}
