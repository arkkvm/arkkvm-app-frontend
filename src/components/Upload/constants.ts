/**
 * ============================================================
 *  WebRTC File Upload — Backpressure Architecture Notes
 * ============================================================
 *
 * Problem: sending a large file via DataChannel.send() in one burst may cause OOM or UI freeze.
 * Solution: two-layer "brake" strategy + a global queue to keep browser memory stable,
 * UI responsive, and ensure only one file uploads at a time.
 *
 *  JS send loop ──chunk──▶ DataChannel buffer ──SCTP──▶ device side
 *       ▲                      │
 *       │ ② setTimeout         │ ① bufferedAmount
 *       │  yield main thread    │  control browser memory
 *
 * ① Browser memory protection (bufferedAmount)
 *    DataChannel maintains an internal send queue; pending bytes accumulate in bufferedAmount.
 *    · Above 1MB -> pause send()
 *    · Back to 256KB -> onbufferedamountlow resumes sending automatically
 *    Analogy: close the tap when the pipe is full, reopen when water level drops.
 *
 * ② Main-thread responsiveness (setTimeout scheduling)
 *    JS is single-threaded. If a while-loop sends hundreds of chunks continuously,
 *    UI rendering and input events can be blocked.
 *    · After every 8 chunks, call setTimeout(fn, 0) to yield control to the browser
 *    · Browser handles rendering/events first, then resumes sending
 *    Analogy: take a short break every few steps to avoid locking up the page.
 *
 * ③ Global serial queue
 *    Module-level _globalUploading works as a lock so only one file uploads at a time.
 *    Later files are queued in _globalUploadQueue and start automatically when previous upload finishes.
 *    Users can see queued files in "pending" state in task list.
 *
 * Note: device side does not currently support ACK receipts,
 * so ACK sliding-window backpressure is not enabled.
 * If device side later provides an { AlreadyUploadedBytes } receipt protocol,
 * ACK-window logic can be reintroduced in onmessage as a third protection layer.
 *
 * Key parameters (tunable by network conditions):
 *   · CHUNK_SIZE       = 4KB    — bytes per send() call
 *   · HIGH_WATER_MARK  = 1MB    — pause threshold for buffer
 *   · LOW_WATER_MARK   = 256KB  — resume threshold for buffer
 *   · CHUNKS_PER_TICK  = 8      — chunks sent in each macrotask batch
 * ============================================================
 */

/** DataChannel bufferedAmount resume threshold (256KB) */
export const DEFAULT_LOW_WATER_MARK = 256 * 1024;

/** DataChannel bufferedAmount pause threshold (1MB) */
export const DEFAULT_HIGH_WATER_MARK = 1 * 1024 * 1024;

/** Per-chunk data size (4KB) */
export const CHUNK_SIZE = 4 * 1024;

/**
 * HTTP POST slice size for device uploads (32MiB).
 * Intentionally separate from WebRTC CHUNK_SIZE (4KB): each HTTP request is one
 * durable slice that is finalized (fsync) before the client advances its ack.
 */
export const HTTP_CHUNK_SIZE = 32 * 1024 * 1024;

/** Maximum chunks sent per macrotask */
export const CHUNKS_PER_TICK = 8;

/** Upload lock timeout (60s) to avoid deadlocks */
export const UPLOAD_LOCK_TIMEOUT = 60_000;

/** Timeout waiting for device confirmation after final send (30s) */
export const FINALIZE_TIMEOUT = 30_000;

/**
 * ACK sliding-window ceiling: max bytes the frontend `offset` (sentBytes) may run
 * ahead of the device-confirmed `AlreadyUploadedBytes` before we pause sending.
 * Prevents the sender from racing far ahead of the device's receive/write speed
 * (which otherwise floods DataChannel bufferedAmount and triggers backpressure).
 */
export const MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;

/**
 * Base ACK stall timeout (60s). The actual timeout used at runtime is computed
 * by `getAckStallTimeout(fileSize)` so large uploads on slow/cloud networks are
 * not aborted by temporary ACK delays.
 */
export const ACK_STALL_TIMEOUT = 60_000;

/** Maximum ACK stall timeout (10 minutes). */
export const MAX_ACK_STALL_TIMEOUT = 10 * 60 * 1000;

/**
 * Compute the ACK stall timeout for a given file size.
 *
 * On slow/cloud networks, device ACKs can be delayed by buffering, congestion,
 * or TURN relay without the device actually stopping. We scale the timeout with
 * file size so huge files are allowed more patience, while small files still
 * fail fast when the channel is truly dead.
 *
 * Formula: 60s base + 1s per MB, capped at 10 minutes.
 */
export const getAckStallTimeout = (fileSize: number): number => {
  const extraMs = (fileSize / (1024 * 1024)) * 1000;
  return Math.min(ACK_STALL_TIMEOUT + extraMs, MAX_ACK_STALL_TIMEOUT);
};
