import { useCallback, useEffect, useRef } from 'react';
import type { MouseInputMode } from '@/components/settings/UsbMouseModeSync';

type AbsMoveHandler = (x: number, y: number, buttons: number) => void
type RelMoveHandler = (params: {
  dx: number
  dy: number
  buttons: number
  x: number
  y: number
}) => void
type ClickEventHandler = (button: number) => void
export type DoubleClickSource = 'mouse' | 'touch'
type DoubleClickEventHandler = (
  button: number,
  x: number,
  y: number,
  source: DoubleClickSource,
) => void | Promise<void>

interface MouseEventsOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>
  onAbsMove?: AbsMoveHandler
  onRelMove?: RelMoveHandler
  onWheel?: (data: {
    deltaX: number
    deltaY: number
    wheelX: number
    wheelY: number
  }) => void
  onClick?: ClickEventHandler
  onDoubleClick?: DoubleClickEventHandler
  onRightClick?: ClickEventHandler
  mode?: MouseInputMode
  videoWidth?: number
  videoHeight?: number
  enabled?: boolean
  scrollThrottling?: number | boolean
  invertScroll?: boolean
  jiggler?: boolean
  isCursorHidden?: boolean
  /** HDMI connection state - when not 'ready', bypass coordinate deduplication to allow wake-from-sleep */
  hdmiConnectionState?: string
}

// Cursor visibility is controlled by the Hide Cursor setting only.
// const POINTER_LOCK_AVAILABLE =
//   window.location.protocol === 'https:' ||
//   window.location.hostname === 'localhost';


const MOUSE_CONSTANTS = {
  MAX_COORDINATE: 32767,
  MAX_DELTA_PER_FRAME: 500,
  INT8_MIN: -128,
  INT8_MAX: 127,
  DEFAULT_THROTTLE_MS: 60,
} as const;

const normalizeWheelDelta = (delta: number): number => {
  if (!Number.isFinite(delta) || delta === 0) {
    return 0;
  }

  const normalized =
    Math.abs(delta) >= 100 ? delta / 100 : Math.sign(delta);

  const clamped = Math.max(-127, Math.min(127, normalized));

  return Math.trunc(clamped) || Math.sign(clamped);
};

const TOUCH_CONSTANTS = {
  DOUBLE_TAP_DELAY: 400,
  DOUBLE_TAP_DISTANCE: 30,
  TAP_DELAY_OFFSET: 50,
  DRAG_START_DISTANCE: 8,
  TWO_FINGER_TAP_DELAY: 500,
  TWO_FINGER_TAP_DISTANCE: 24,
  TWO_FINGER_SCROLL_STEP_DISTANCE: 16,
  BUTTON_RELEASE_DELAY: 50,
  CONTEXT_MENU_NAVIGATION_TIMEOUT: 5_000,
  CONTEXT_MENU_SELECTION_DISTANCE: 5,
} as const;

interface TwoFingerTapState {
  startedAt: number
  centerX: number
  centerY: number
  moved: boolean
  scrolling: boolean
  lastCenterY: number
  scrollAccumulatorY: number
  startPoints: Array<{
    identifier: number
    x: number
    y: number
  }>
}

interface TouchContextMenuArmedState {
  phase: 'armed'
  expiresAt: number
  pointerClientX: number
  pointerClientY: number
}

interface TouchContextMenuTrackingState {
  phase: 'tracking'
  expiresAt: number
  identifier: number
  startTouchX: number
  startTouchY: number
  lastTouchX: number
  lastTouchY: number
  pointerClientX: number
  pointerClientY: number
  maxDistance: number
  canceled: boolean
}

type TouchContextMenuState =
  | TouchContextMenuArmedState
  | TouchContextMenuTrackingState

const JIGGLER_CONSTANTS = {
  IDLE_MS: 20_000,
  PERIOD_MS: 30_000,
  AMPLITUDE: 1,
  RESET_DELAY: 16,
} as const;

const isEventOnVideo = (
  e: PointerEvent | MouseEvent,
  videoRef: React.RefObject<HTMLVideoElement | null>
): boolean => {
  const target = e.target as HTMLElement;
  const video = videoRef.current;
  if (!video || !target) return false;
  // Primary check: event originated directly on or inside the video element.
  if (target === video || video.contains(target)) return true;
  // Fallback: coordinate-based hit-test.
  // When video has no content (sleep/no-signal), use the [data-video-area] overlay rect
  // so that only events inside the signal area trigger wake-from-sleep HID input.
  const videoRect = video.getBoundingClientRect();
  const hasVideoSize = videoRect.width > 0 && videoRect.height > 0;
  const hitRect = hasVideoSize
    ? videoRect
    : (video.closest('.relative')?.querySelector('[data-video-area]')?.getBoundingClientRect() ?? videoRect);
  return (
    e.clientX >= hitRect.left &&
    e.clientX <= hitRect.right &&
    e.clientY >= hitRect.top &&
    e.clientY <= hitRect.bottom
  );
};

const getRelativeMouseAreaRect = (
  video: HTMLVideoElement
): DOMRect | null => {
  return (
    video.parentElement?.getBoundingClientRect() ??
    video.getBoundingClientRect()
  );
};

const isEventInRelativeMouseArea = (
  e: PointerEvent | MouseEvent,
  videoRef: React.RefObject<HTMLVideoElement | null>
): boolean => {
  const video = videoRef.current;
  if (!video) return false;
  const rect = getRelativeMouseAreaRect(video);
  if (!rect) return false;
  return (
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  );
};

const isEventBlockedByOverlay = (e: Event): boolean => {
  const target = e.target as HTMLElement;
  if (!target) return false;
  // Check if target or any ancestor has data-kvm-ignore attribute
  if (target.closest('[data-kvm-ignore="true"]')) return true;
  return !!target.closest(
    '[role="dialog"], [role="alertdialog"], [data-radix-dialog-overlay], [data-radix-popover-content], [data-slot="dialog-overlay"], [data-slot="dialog-content"], [data-panel], [data-sidebar]'
  );
};

const isTouchLikePointer = (e: PointerEvent): boolean => {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
};

const syntheticTouchPointerEvents = new WeakSet<PointerEvent>();

const isSyntheticTouchPointer = (e: PointerEvent): boolean => {
  return syntheticTouchPointerEvents.has(e);
};

const createTouchPointerEvent = (
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
  buttons: number
): PointerEvent => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: buttons === 2 ? 2 : 0,
    buttons,
    pointerId: 1,
    pointerType: 'touch',
  });
  syntheticTouchPointerEvents.add(event);
  return event;
};

const getControlSurface = (
  videoRef: React.RefObject<HTMLVideoElement | null>
): HTMLElement | null => {
  const video = videoRef.current;
  return (
    video?.closest('[data-kvm-control-surface="true"]') as HTMLElement | null
  ) ?? video?.parentElement ?? null;
};

const focusControlSurface = (
  videoRef: React.RefObject<HTMLVideoElement | null>
): void => {
  const surface = getControlSurface(videoRef);
  try {
    surface?.focus({ preventScroll: true });
  } catch {}
};

export function useMouseEvents(options: MouseEventsOptions) {
  const {
    videoRef,
    onAbsMove,
    onRelMove,
    onWheel,
    onClick,
    onDoubleClick,
    onRightClick,
    videoWidth = 1920,
    videoHeight = 1080,
    mode = 'absolute',
    scrollThrottling,
    invertScroll = false,
    jiggler,
  } = options;
  const enabled = options.enabled ?? true;

  const throttleMs =
    typeof scrollThrottling === 'number'
      ? Math.max(0, scrollThrottling)
      : scrollThrottling
        ? MOUSE_CONSTANTS.DEFAULT_THROTTLE_MS
        : 0;

  const latestPointer = useRef<{
    x: number
    y: number
    buttons: number
  } | null>(null);
  const lastSent = useRef<{ x: number; y: number; buttons: number } | null>(
    null
  );
  const blockWheelEventRef = useRef(false);
  const wheelBlockTimerRef = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);
  const lastActivityTs = useRef<number>(Date.now());
  const jigglerTimer = useRef<number | null>(null);
  const twoFingerTapRef = useRef<TwoFingerTapState | null>(null);
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const touchLeftButtonDownRef = useRef(false);
  const touchRightClickTimerRef = useRef<number | null>(null);
  const touchSequenceRef = useRef(0);
  const touchDoubleClickCompletionRef = useRef<Promise<void> | null>(null);
  const touchContextMenuRef = useRef<TouchContextMenuState | null>(null);

  const transform = useRef({
    scale: 1,
    offX: 0,
    offY: 0,
    vw: videoWidth,
    vh: videoHeight,
  });

  const virtualPos = useRef<{ x: number; y: number } | null>(null);
  const isLockedRef = useRef(false);

  const recomputeTransform = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const vw = v.videoWidth || videoWidth;
    const vh = v.videoHeight || videoHeight;
    const rect = v.getBoundingClientRect();
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const displayW = vw * scale;
    const displayH = vh * scale;
    const offX = rect.left + (rect.width - displayW) / 2;
    const offY = rect.top + (rect.height - displayH) / 2;
    transform.current = { scale, offX, offY, vw, vh };

  }, [videoRef, videoWidth, videoHeight]);

  const scheduleFlush = useCallback(() => {
    if (!onAbsMove) {

      return;
    }
    if (rafId.current) {

      return;
    }
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const lp = latestPointer.current;
      if (!lp) {

        return;
      }
      const last = lastSent.current;
      const hdmiNotReady = options.hdmiConnectionState !== 'ready';
      // Bypass deduplication when HDMI has no signal (S3/sleep state) to allow wake-from-sleep
      if (
        !last ||
        last.x !== lp.x ||
        last.y !== lp.y ||
        last.buttons !== lp.buttons ||
        hdmiNotReady
      ) {

        onAbsMove(lp.x, lp.y, lp.buttons);
        lastSent.current = lp;
      } else {

      }
    });
  }, [onAbsMove, options.hdmiConnectionState]);

  const computeAbsPayload = (e: PointerEvent) => {
    const v = videoRef.current;
    if (v) {
      const vw = v.videoWidth || videoWidth;
      const vh = v.videoHeight || videoHeight;
      const rect = v.getBoundingClientRect();
      const scale = Math.min(rect.width / vw, rect.height / vh);
      const displayW = vw * scale;
      const displayH = vh * scale;
      const offX = rect.left + (rect.width - displayW) / 2;
      const offY = rect.top + (rect.height - displayH) / 2;
      transform.current = { scale, offX, offY, vw, vh };
    }

    const t = transform.current;
    // Guard against invalid transform when video has no signal (zero dimensions)
    if (t.scale <= 0 || t.vw <= 0 || t.vh <= 0) {
      return { x: 0, y: 0, buttons: e.buttons || 0 };
    }
    const rx = e.clientX - t.offX;
    const ry = e.clientY - t.offY;
    if (rx < 0 || ry < 0 || rx > t.vw * t.scale || ry > t.vh * t.scale)
      return null;
    const x = Math.floor(rx / t.scale);
    const y = Math.floor(ry / t.scale);
    // Guard against NaN from divide-by-zero when video dimensions are 1
    const normalizedX = t.vw > 1 ? Math.round((x / (t.vw - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE) : 0;
    const normalizedY = t.vh > 1 ? Math.round((y / (t.vh - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE) : 0;
    return {
      x: normalizedX,
      y: normalizedY,
      buttons: e.buttons || 0,
    };
  };


  const absMouseMovePointerEvent = useCallback(
    (e: PointerEvent) => {
      if (!onAbsMove) return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isSyntheticTouchPointer(e) && !isEventOnVideo(e, videoRef)) return;
      focusControlSurface(videoRef);
      lastActivityTs.current = Date.now();
      const t = transform.current;

      if (mode === 'relative' && isLockedRef.current) {
        if (!virtualPos.current) {
          virtualPos.current = {
            x: Math.floor(t.vw / 2),
            y: Math.floor(t.vh / 2),
          };
        }
        const dx = e.movementX / (t.scale || 1);
        const dy = e.movementY / (t.scale || 1);
        const nx = Math.max(
          0,
          Math.min(t.vw - 1, Math.round(virtualPos.current.x + dx))
        );
        const ny = Math.max(
          0,
          Math.min(t.vh - 1, Math.round(virtualPos.current.y + dy))
        );
        virtualPos.current = { x: nx, y: ny };
        const absX = Math.round((nx / (t.vw - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE);
        const absY = Math.round((ny / (t.vh - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE);
        latestPointer.current = { x: absX, y: absY, buttons: e.buttons || 0 };
        scheduleFlush();
        return;
      }

      const payload = computeAbsPayload(e);
      if (!payload) {

        return;
      }
      latestPointer.current = payload;
      scheduleFlush();
    },
    [onAbsMove, mode, scheduleFlush]
  );

  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  const relAggRef = useRef<{ dx: number; dy: number; buttons: number }>({
    dx: 0,
    dy: 0,
    buttons: 0,
  });
  const relRafIdRef = useRef<number | null>(null);
  const clampI8 = (n: number) =>
    Math.max(MOUSE_CONSTANTS.INT8_MIN, Math.min(MOUSE_CONSTANTS.INT8_MAX, n));
  const flushPendingRelMove = useCallback(
    (x: number, y: number) => {
      if (!onRelMove || mode !== 'relative') return;
      let { dx, dy, buttons } = relAggRef.current;
      relAggRef.current = { dx: 0, dy: 0, buttons };

      dx = Math.max(
        -MOUSE_CONSTANTS.MAX_DELTA_PER_FRAME,
        Math.min(MOUSE_CONSTANTS.MAX_DELTA_PER_FRAME, dx)
      );
      dy = Math.max(
        -MOUSE_CONSTANTS.MAX_DELTA_PER_FRAME,
        Math.min(MOUSE_CONSTANTS.MAX_DELTA_PER_FRAME, dy)
      );
      dx = Math.trunc(dx);
      dy = Math.trunc(dy);
      while (dx !== 0 || dy !== 0) {
        const stepX = clampI8(dx);
        const stepY = clampI8(dy);
        if (stepX === 0 && stepY === 0) break;
        onRelMove({ dx: stepX, dy: stepY, buttons, x, y });
        dx -= stepX;
        dy -= stepY;
      }
    },
    [onRelMove, mode]
  );
  const relMouseMovePointerEvent = useCallback(
    (e: PointerEvent) => {
      if (!onRelMove || mode !== 'relative') return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      // When pointer lock is active, movement is unbounded by element edges.
      if (!isLockedRef.current && !isEventInRelativeMouseArea(e, videoRef)) return;
      focusControlSurface(videoRef);
      lastActivityTs.current = Date.now();
      let { movementX, movementY, buttons } = e;

      if (!isLockedRef.current) {
        const lc = lastClientRef.current;
        if (lc) {
          movementX = e.clientX - lc.x;
          movementY = e.clientY - lc.y;
        }
        lastClientRef.current = { x: e.clientX, y: e.clientY };
      }

      const dxRaw = movementX || 0;
      const dyRaw = movementY || 0;
      relAggRef.current.dx += dxRaw;
      relAggRef.current.dy += dyRaw;
      relAggRef.current.buttons = buttons || 0;
      if (relRafIdRef.current == null) {
        relRafIdRef.current = requestAnimationFrame(() => {
          relRafIdRef.current = null;
          flushPendingRelMove(movementX, movementY);
        });
      }
    },
    [onRelMove, mode, flushPendingRelMove]
  );

  // const requestPointerLock = useCallback(() => {
  //   if (mode !== 'relative' || !POINTER_LOCK_AVAILABLE) return;
  //   const v = videoRef.current;
  //   if (!v) return;
  //   try {
  //     v.requestPointerLock();
  //   } catch {}
  // }, [mode, videoRef]);
  const emitWheelDelta = useCallback(
    (deltaX: number, deltaY: number): boolean => {
      lastActivityTs.current = Date.now();
      if (!onWheel) return false;
      if (throttleMs > 0 && blockWheelEventRef.current) {
        return false;
      }

      const wheelY =
        (invertScroll ? 1 : -1) * normalizeWheelDelta(deltaY);

      const wheelX =
        (invertScroll ? -1 : 1) * normalizeWheelDelta(deltaX);

      if (wheelY === 0 && wheelX === 0) {
        return false;
      }
      onWheel({
        deltaX: ~~deltaX,
        deltaY: ~~deltaY,
        wheelX: ~~wheelX,
        wheelY: ~~wheelY,
      });

      if (throttleMs > 0) {
        blockWheelEventRef.current = true;

        if (wheelBlockTimerRef.current !== null) {
          window.clearTimeout(wheelBlockTimerRef.current);
        }

        wheelBlockTimerRef.current = window.setTimeout(() => {
          blockWheelEventRef.current = false;
          wheelBlockTimerRef.current = null;
        }, throttleMs);
      }

      return true;
    },
    [onWheel, throttleMs, invertScroll]
  );

  const onWheelInternal = useCallback(
    (e: WheelEvent) => {
      if (isEventBlockedByOverlay(e)) return;

      lastActivityTs.current = Date.now();

      if (!onWheel) return;

      recomputeTransform();

      const t = transform.current;
      const rx = e.clientX - t.offX;
      const ry = e.clientY - t.offY;

      const inArea =
        rx >= 0 &&
        ry >= 0 &&
        rx <= t.vw * t.scale &&
        ry <= t.vh * t.scale;

      if (!inArea) return;

      e.preventDefault();
      emitWheelDelta(e.deltaX, e.deltaY);
    },
    [onWheel, recomputeTransform, isEventBlockedByOverlay, emitWheelDelta]
  );

  const inEffectiveAreaByClient = (clientX: number, clientY: number) => {
    const t = transform.current;
    const rx = clientX - t.offX;
    const ry = clientY - t.offY;
    return !(rx < 0 || ry < 0 || rx > t.vw * t.scale || ry > t.vh * t.scale);
  };

  const handleClick = useCallback(
    (e: MouseEvent) => {
      // Cursor visibility is controlled by the Hide Cursor setting only.
      // if (mode === 'relative' && POINTER_LOCK_AVAILABLE) {
      //   requestPointerLock();
      // }
      if (!onClick) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isEventOnVideo(e, videoRef)) return;
      lastActivityTs.current = Date.now();
      if (!inEffectiveAreaByClient(e.clientX, e.clientY)) return;
      if (e.detail >= 2) return;
      onClick(e.button);
    },
    [onClick]
  );

  const handleDoubleClick = useCallback(
    (e: MouseEvent) => {
      if (!onDoubleClick) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isEventOnVideo(e, videoRef)) return;
      lastActivityTs.current = Date.now();
      if (!inEffectiveAreaByClient(e.clientX, e.clientY)) return;
      const payload = computeAbsPayload(e as unknown as PointerEvent);
      if (!payload) return;
      onDoubleClick(e.button, payload.x, payload.y, 'mouse');
    },
    [onDoubleClick]
  );

  const handleRightClick = useCallback(
    (e: MouseEvent) => {
      // Check if event should be blocked before preventing default
      if (isEventBlockedByOverlay(e)) {
        // Allow native context menu for settings panel
        return;
      }
      e.preventDefault();
      if (!onRightClick) return;
      if (!isEventOnVideo(e, videoRef)) return;
      lastActivityTs.current = Date.now();
      if (!inEffectiveAreaByClient(e.clientX, e.clientY)) return;
      onRightClick(e.button);
    },
    [onRightClick]
  );

  const cancelPendingAbsMove = useCallback(() => {
    latestPointer.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  const absPointerDown = useCallback(
    (e: PointerEvent) => {
      if (!onAbsMove) return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isSyntheticTouchPointer(e) && !isEventOnVideo(e, videoRef)) return;
      focusControlSurface(videoRef);
      // Desktop pointer moves are coalesced into the next animation frame.
      // Drop an older move before a button transition so it cannot arrive
      // after this press and overwrite the current button state.
      if (!isTouchLikePointer(e)) {
        cancelPendingAbsMove();
      }
      try {
        getControlSurface(videoRef)?.setPointerCapture(e.pointerId);
      } catch {}
      const payload = computeAbsPayload(e);
      if (!payload) return;
      lastSent.current = payload;
      onAbsMove(payload.x, payload.y, payload.buttons);
    },
    [cancelPendingAbsMove, onAbsMove, videoRef]
  );

  const absPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!onAbsMove) return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isSyntheticTouchPointer(e) && !isEventOnVideo(e, videoRef)) return;
      // A queued drag move still contains buttons=1. Cancel it before sending
      // buttons=0, otherwise the stale move can leave the remote button stuck.
      // Synthetic touch events use the same RAF queue as mouse movement; native
      // pen input keeps its existing coalescing behavior.
      if (!isTouchLikePointer(e) || isSyntheticTouchPointer(e)) {
        cancelPendingAbsMove();
      }
      try {
        getControlSurface(videoRef)?.releasePointerCapture(e.pointerId);
      } catch {}
      const payload = computeAbsPayload(e);
      if (!payload) {
        if (isSyntheticTouchPointer(e)) {
          const last = lastSent.current;
          if (last && last.buttons !== 0) {
            onAbsMove(last.x, last.y, 0);
            lastSent.current = { ...last, buttons: 0 };
          }
        }
        return;
      }
      lastSent.current = payload;
      onAbsMove(payload.x, payload.y, payload.buttons);
    },
    [cancelPendingAbsMove, onAbsMove, videoRef]
  );

  const relPointerDown = useCallback(
    (e: PointerEvent) => {
      if (!onRelMove || mode !== 'relative') return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      if (!isLockedRef.current && !isEventInRelativeMouseArea(e, videoRef)) return;
      focusControlSurface(videoRef);
      if (isTouchLikePointer(e)) {
        try {
          getControlSurface(videoRef)?.setPointerCapture(e.pointerId);
        } catch {}
      }
      const buttons = e.buttons || 0;
      onRelMove({
        dx: 0,
        dy: 0,
        buttons,
        x: e.movementX || 0,
        y: e.movementY || 0,
      });
    },
    [onRelMove, mode, videoRef]
  );

  const relPointerUp = useCallback(
    (e: PointerEvent) => {
      if (!onRelMove || mode !== 'relative') return;
      if (e.pointerType === 'touch' && !isSyntheticTouchPointer(e)) return;
      if (isEventBlockedByOverlay(e)) return;
      if (
        !isLockedRef.current &&
        !isSyntheticTouchPointer(e) &&
        !isEventInRelativeMouseArea(e, videoRef)
      ) {
        return;
      }
      if (isTouchLikePointer(e)) {
        try {
          getControlSurface(videoRef)?.releasePointerCapture(e.pointerId);
        } catch {}
      }
      if (isSyntheticTouchPointer(e)) {
        relAggRef.current = { dx: 0, dy: 0, buttons: 0 };
        if (relRafIdRef.current !== null) {
          cancelAnimationFrame(relRafIdRef.current);
          relRafIdRef.current = null;
        }
        lastClientRef.current = null;
      }
      const buttons = e.buttons || 0;
      onRelMove({
        dx: 0,
        dy: 0,
        buttons,
        x: e.movementX || 0,
        y: e.movementY || 0,
      });
    },
    [onRelMove, mode, videoRef]
  );

  const releasePointerState = useCallback(() => {
    latestPointer.current = null;
    lastClientRef.current = null;
    relAggRef.current = { dx: 0, dy: 0, buttons: 0 };

    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }

    if (relRafIdRef.current) {
      cancelAnimationFrame(relRafIdRef.current);
      relRafIdRef.current = null;
    }

    if (mode === 'relative') {
      onRelMove?.({
        dx: 0,
        dy: 0,
        buttons: 0,
        x: 0,
        y: 0,
      });
      return;
    }

    const last = lastSent.current;
    if (last && last.buttons !== 0) {
      onAbsMove?.(last.x, last.y, 0);
      lastSent.current = { ...last, buttons: 0 };
    }
  }, [mode, onAbsMove, onRelMove]);

  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const tapTimeoutRef = useRef<number | null>(null);
  const touchEndTimerRef = useRef<number | null>(null); // Track touchEnd setTimeout
  const jigglerResetTimerRef = useRef<number | null>(null); // Track jiggler reset setTimeout

  const clearPendingTouchState = useCallback(() => {
    touchSequenceRef.current += 1;
    if (tapTimeoutRef.current !== null) {
      window.clearTimeout(tapTimeoutRef.current);
      tapTimeoutRef.current = null;
    }
    if (touchEndTimerRef.current !== null) {
      window.clearTimeout(touchEndTimerRef.current);
      touchEndTimerRef.current = null;
    }
    if (touchRightClickTimerRef.current !== null) {
      window.clearTimeout(touchRightClickTimerRef.current);
      touchRightClickTimerRef.current = null;
    }
    twoFingerTapRef.current = null;
    touchContextMenuRef.current = null;
    touchStartPointRef.current = null;
    touchLeftButtonDownRef.current = false;
    lastTapRef.current = null;
  }, []);

  const updateTouchContextMenuPointer = useCallback(
    (state: TouchContextMenuTrackingState, touch: Touch) => {
      const deltaX = touch.clientX - state.lastTouchX;
      const deltaY = touch.clientY - state.lastTouchY;
      state.lastTouchX = touch.clientX;
      state.lastTouchY = touch.clientY;
      state.pointerClientX += deltaX;
      state.pointerClientY += deltaY;
      state.maxDistance = Math.max(
        state.maxDistance,
        Math.hypot(
          touch.clientX - state.startTouchX,
          touch.clientY - state.startTouchY
        )
      );

      if (mode === 'absolute') {
        const currentTransform = transform.current;
        if (
          currentTransform.scale > 0 &&
          currentTransform.vw > 0 &&
          currentTransform.vh > 0
        ) {
          state.pointerClientX = Math.max(
            currentTransform.offX,
            Math.min(
              currentTransform.offX +
                currentTransform.vw * currentTransform.scale,
              state.pointerClientX
            )
          );
          state.pointerClientY = Math.max(
            currentTransform.offY,
            Math.min(
              currentTransform.offY +
                currentTransform.vh * currentTransform.scale,
              state.pointerClientY
            )
          );
        }
      }

      return mode === 'relative'
        ? { clientX: touch.clientX, clientY: touch.clientY }
        : {
            clientX: state.pointerClientX,
            clientY: state.pointerClientY,
          };
    },
    [mode]
  );

  const sendTouchRightClick = useCallback(
    (clientX: number, clientY: number) => {
      const touchSequence = ++touchSequenceRef.current;
      const beginRightClick = () => {
        if (touchSequence !== touchSequenceRef.current) return;
        const pointerDown = createTouchPointerEvent(
          'pointerdown',
          clientX,
          clientY,
          2
        );

        if (mode === 'relative') {
          relPointerDown(pointerDown);
        } else {
          absPointerDown(pointerDown);
        }

        touchRightClickTimerRef.current = window.setTimeout(() => {
          touchRightClickTimerRef.current = null;
          const pointerUp = createTouchPointerEvent(
            'pointerup',
            clientX,
            clientY,
            0
          );

          if (mode === 'relative') {
            relPointerUp(pointerUp);
            lastClientRef.current = null;
          } else {
            absPointerUp(pointerUp);
          }
          touchContextMenuRef.current = {
            phase: 'armed',
            expiresAt:
              Date.now() + TOUCH_CONSTANTS.CONTEXT_MENU_NAVIGATION_TIMEOUT,
            pointerClientX: clientX,
            pointerClientY: clientY,
          };
          lastTapRef.current = null;
        }, TOUCH_CONSTANTS.BUTTON_RELEASE_DELAY);
      };

      const doubleClickCompletion = touchDoubleClickCompletionRef.current;
      if (doubleClickCompletion) {
        void doubleClickCompletion.then(beginRightClick, beginRightClick);
        return;
      }
      beginRightClick();
    },
    [mode, relPointerDown, relPointerUp, absPointerDown, absPointerUp]
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const contextMenuState = touchContextMenuRef.current;
      if (contextMenuState?.phase === 'tracking') {
        if (e.touches.length < 2) return;
        // An extra finger cancels menu navigation for this entire touch
        // sequence. Do not reinterpret it as a fresh two-finger right-click.
        contextMenuState.canceled = true;
        cancelPendingAbsMove();
        relAggRef.current = { dx: 0, dy: 0, buttons: 0 };
        if (relRafIdRef.current !== null) {
          cancelAnimationFrame(relRafIdRef.current);
          relRafIdRef.current = null;
        }
        lastClientRef.current = null;
        return;
      }

      if (e.touches.length >= 2) {
        touchContextMenuRef.current = null;
        const activeGesture = twoFingerTapRef.current;
        if (activeGesture) {
          const hasUntrackedTouch = Array.from(e.touches).some(
            touch =>
              !activeGesture.startPoints.some(
                startPoint => startPoint.identifier === touch.identifier
              )
          );
          if (e.touches.length > 2 || hasUntrackedTouch) {
            activeGesture.moved = true;
            activeGesture.scrolling = false;
          }
          return;
        }

        touchSequenceRef.current += 1;

        if (tapTimeoutRef.current !== null) {
          window.clearTimeout(tapTimeoutRef.current);
          tapTimeoutRef.current = null;
        }
        if (touchEndTimerRef.current !== null) {
          window.clearTimeout(touchEndTimerRef.current);
          touchEndTimerRef.current = null;
        }
        if (touchRightClickTimerRef.current !== null) {
          window.clearTimeout(touchRightClickTimerRef.current);
          touchRightClickTimerRef.current = null;
          releasePointerState();
        }

        const firstTouch = e.touches[0];
        const secondTouch = e.touches[1];
        if (!firstTouch || !secondTouch) return;

        const hadActiveLeftDrag = touchLeftButtonDownRef.current;
        if (hadActiveLeftDrag) {
          releasePointerState();
        } else {
          cancelPendingAbsMove();
          relAggRef.current = { dx: 0, dy: 0, buttons: 0 };
          if (relRafIdRef.current !== null) {
            cancelAnimationFrame(relRafIdRef.current);
            relRafIdRef.current = null;
          }
          lastClientRef.current = null;
        }

        touchLeftButtonDownRef.current = false;
        touchStartPointRef.current = null;
        lastTapRef.current = null;
        twoFingerTapRef.current = {
          startedAt: Date.now(),
          centerX: (firstTouch.clientX + secondTouch.clientX) / 2,
          centerY: (firstTouch.clientY + secondTouch.clientY) / 2,
          moved: hadActiveLeftDrag || e.touches.length !== 2,
          scrolling: false,
          lastCenterY: (firstTouch.clientY + secondTouch.clientY) / 2,
          scrollAccumulatorY: 0,
          startPoints: [firstTouch, secondTouch].map(touch => ({
            identifier: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
          })),
        };
        return;
      }

      if (twoFingerTapRef.current) return;

      const touch = e.touches[0];
      if (!touch) return;

      const armedContextMenu = touchContextMenuRef.current;
      if (armedContextMenu?.phase === 'armed') {
        if (Date.now() <= armedContextMenu.expiresAt) {
          // After a touch right-click, use one single-finger gesture as a
          // temporary touchpad: movement only hovers, and lift confirms.
          touchSequenceRef.current += 1;
          if (tapTimeoutRef.current !== null) {
            window.clearTimeout(tapTimeoutRef.current);
            tapTimeoutRef.current = null;
          }
          if (touchEndTimerRef.current !== null) {
            window.clearTimeout(touchEndTimerRef.current);
            touchEndTimerRef.current = null;
          }
          if (touchLeftButtonDownRef.current) {
            releasePointerState();
          }

          touchLeftButtonDownRef.current = false;
          touchStartPointRef.current = null;
          lastTapRef.current = null;
          touchContextMenuRef.current = {
            phase: 'tracking',
            expiresAt: armedContextMenu.expiresAt,
            identifier: touch.identifier,
            startTouchX: touch.clientX,
            startTouchY: touch.clientY,
            lastTouchX: touch.clientX,
            lastTouchY: touch.clientY,
            pointerClientX: armedContextMenu.pointerClientX,
            pointerClientY: armedContextMenu.pointerClientY,
            maxDistance: 0,
            canceled: false,
          };
          if (mode === 'relative') {
            lastClientRef.current = {
              x: touch.clientX,
              y: touch.clientY,
            };
          }
          return;
        }
        touchContextMenuRef.current = null;
      }

      if (touchRightClickTimerRef.current !== null) {
        window.clearTimeout(touchRightClickTimerRef.current);
        touchRightClickTimerRef.current = null;
        releasePointerState();
      }

      touchStartPointRef.current = {
        x: touch.clientX,
        y: touch.clientY,
      };

      const now = Date.now();
      const currentTap = {
        time: now,
        x: touch.clientX,
        y: touch.clientY,
      };

      let isDoubleClick = false;
      if (lastTapRef.current) {
        const timeDiff = now - lastTapRef.current.time;
        const distance = Math.sqrt(
          Math.pow(currentTap.x - lastTapRef.current.x, 2) +
            Math.pow(currentTap.y - lastTapRef.current.y, 2)
        );

        if (timeDiff < TOUCH_CONSTANTS.DOUBLE_TAP_DELAY && distance < TOUCH_CONSTANTS.DOUBLE_TAP_DISTANCE) {
          isDoubleClick = true;
          lastTapRef.current = null;
          touchSequenceRef.current += 1;

          if (tapTimeoutRef.current !== null) {
            window.clearTimeout(tapTimeoutRef.current);
            tapTimeoutRef.current = null;
          }
          if (touchEndTimerRef.current !== null) {
            window.clearTimeout(touchEndTimerRef.current);
            touchEndTimerRef.current = null;
          }

          if (touchLeftButtonDownRef.current) {
            releasePointerState();
            touchLeftButtonDownRef.current = false;

            const pointerDown = createTouchPointerEvent(
              'pointerdown',
              currentTap.x,
              currentTap.y,
              1
            );
            if (mode === 'relative') {
              lastClientRef.current = {
                x: currentTap.x,
                y: currentTap.y,
              };
              relPointerDown(pointerDown);
            } else {
              absPointerDown(pointerDown);
            }
            touchLeftButtonDownRef.current = true;
            return;
          }

          if (onDoubleClick) {
            const fakePointer = createTouchPointerEvent(
              'pointerdown',
              currentTap.x,
              currentTap.y,
              1
            );
            const payload = computeAbsPayload(fakePointer);
            if (payload) {
              const completion = onDoubleClick(
                0,
                payload.x,
                payload.y,
                'touch'
              );
              if (completion) {
                const trackedCompletion = Promise.resolve(completion);
                touchDoubleClickCompletionRef.current = trackedCompletion;
                void trackedCompletion.then(
                  () => {
                    if (
                      touchDoubleClickCompletionRef.current ===
                      trackedCompletion
                    ) {
                      touchDoubleClickCompletionRef.current = null;
                    }
                  },
                  () => {
                    if (
                      touchDoubleClickCompletionRef.current ===
                      trackedCompletion
                    ) {
                      touchDoubleClickCompletionRef.current = null;
                    }
                  }
                );
              }
            }
          }
          touchStartPointRef.current = null;
          return;
        } else {
          lastTapRef.current = currentTap;
        }
      } else {
        lastTapRef.current = currentTap;
      }

      if (!isDoubleClick) {
        const touchSequence = ++touchSequenceRef.current;
        if (tapTimeoutRef.current !== null) {
          window.clearTimeout(tapTimeoutRef.current);
          tapTimeoutRef.current = null;
        }
        if (touchEndTimerRef.current !== null) {
          window.clearTimeout(touchEndTimerRef.current);
          touchEndTimerRef.current = null;
        }
        if (touchLeftButtonDownRef.current) {
          releasePointerState();
          touchLeftButtonDownRef.current = false;
        }

        const timerId = window.setTimeout(() => {
          if (tapTimeoutRef.current === timerId) {
            tapTimeoutRef.current = null;
          }
          if (
            touchSequence !== touchSequenceRef.current ||
            twoFingerTapRef.current
          ) {
            return;
          }
          const pointerEvent = createTouchPointerEvent(
            'pointerdown',
            touch.clientX,
            touch.clientY,
            1
          );

          if (mode === 'relative') {
            relPointerDown(pointerEvent);
          } else {
            absPointerDown(pointerEvent);
          }

          touchLeftButtonDownRef.current = true;
        }, TOUCH_CONSTANTS.DOUBLE_TAP_DELAY / 2);
        tapTimeoutRef.current = timerId;
      }
    },
    [
      mode,
      relPointerDown,
      absPointerDown,
      onDoubleClick,
      releasePointerState,
      cancelPendingAbsMove,
    ]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const contextMenuState = touchContextMenuRef.current;
      if (contextMenuState?.phase === 'tracking') {
        if (e.touches.length !== 1) {
          contextMenuState.canceled = true;
          return;
        }
        const touch = Array.from(e.touches).find(
          candidate => candidate.identifier === contextMenuState.identifier
        );
        if (!touch) {
          contextMenuState.canceled = true;
          return;
        }

        const pointerPosition = updateTouchContextMenuPointer(
          contextMenuState,
          touch
        );
        const pointerMove = createTouchPointerEvent(
          'pointermove',
          pointerPosition.clientX,
          pointerPosition.clientY,
          0
        );
        if (mode === 'relative') {
          relMouseMovePointerEvent(pointerMove);
        } else {
          absMouseMovePointerEvent(pointerMove);
        }
        return;
      }

      const twoFingerTap = twoFingerTapRef.current;
      if (twoFingerTap) {
        if (e.touches.length !== 2) {
          twoFingerTap.moved = true;
          twoFingerTap.scrolling = false;
          return;
        }

        const firstStartPoint = twoFingerTap.startPoints[0];
        const secondStartPoint = twoFingerTap.startPoints[1];
        const touches = Array.from(e.touches);
        const firstTouch = touches.find(
          touch => touch.identifier === firstStartPoint?.identifier
        );
        const secondTouch = touches.find(
          touch => touch.identifier === secondStartPoint?.identifier
        );
        if (!firstStartPoint || !secondStartPoint || !firstTouch || !secondTouch) {
          twoFingerTap.moved = true;
          twoFingerTap.scrolling = false;
          return;
        }

        if (twoFingerTap.moved && !twoFingerTap.scrolling) {
          return;
        }

        const currentCenterY = (firstTouch.clientY + secondTouch.clientY) / 2;
        twoFingerTap.scrollAccumulatorY +=
          currentCenterY - twoFingerTap.lastCenterY;
        twoFingerTap.lastCenterY = currentCenterY;

        if (!twoFingerTap.scrolling) {
          const verticalDistance = currentCenterY - twoFingerTap.centerY;
          if (
            Math.abs(verticalDistance) <
            TOUCH_CONSTANTS.TWO_FINGER_SCROLL_STEP_DISTANCE
          ) {
            const movedBeyondTapDistance =
              Math.hypot(
                firstTouch.clientX - firstStartPoint.x,
                firstTouch.clientY - firstStartPoint.y
              ) > TOUCH_CONSTANTS.TWO_FINGER_TAP_DISTANCE ||
              Math.hypot(
                secondTouch.clientX - secondStartPoint.x,
                secondTouch.clientY - secondStartPoint.y
              ) > TOUCH_CONSTANTS.TWO_FINGER_TAP_DISTANCE;
            if (movedBeyondTapDistance) {
              twoFingerTap.moved = true;
            }
            return;
          }

          twoFingerTap.scrolling = true;
          twoFingerTap.moved = true;
        }

        const scrollSteps = Math.trunc(
          twoFingerTap.scrollAccumulatorY /
            TOUCH_CONSTANTS.TWO_FINGER_SCROLL_STEP_DISTANCE
        );
        if (
          scrollSteps !== 0 &&
          emitWheelDelta(0, -scrollSteps * 100)
        ) {
          twoFingerTap.scrollAccumulatorY -=
            scrollSteps * TOUCH_CONSTANTS.TWO_FINGER_SCROLL_STEP_DISTANCE;
        }
        return;
      }

      const touch = e.touches[0];
      if (!touch) return;

      const startPoint = touchStartPointRef.current;
      if (!startPoint) return;

      if (!touchLeftButtonDownRef.current) {
        const dragDistance = Math.hypot(
          touch.clientX - startPoint.x,
          touch.clientY - startPoint.y
        );
        if (dragDistance < TOUCH_CONSTANTS.DRAG_START_DISTANCE) return;

        if (tapTimeoutRef.current !== null) {
          window.clearTimeout(tapTimeoutRef.current);
          tapTimeoutRef.current = null;
        }
        lastTapRef.current = null;

        const pointerDown = createTouchPointerEvent(
          'pointerdown',
          startPoint.x,
          startPoint.y,
          1
        );
        if (mode === 'relative') {
          lastClientRef.current = { x: startPoint.x, y: startPoint.y };
          relPointerDown(pointerDown);
        } else {
          absPointerDown(pointerDown);
        }
        touchLeftButtonDownRef.current = true;
      }

      const pointerEvent = createTouchPointerEvent(
        'pointermove',
        touch.clientX,
        touch.clientY,
        1
      );
      if (mode === 'relative') {
        relMouseMovePointerEvent(pointerEvent);
      } else {
        absMouseMovePointerEvent(pointerEvent);
      }
    },
    [
      mode,
      relPointerDown,
      absPointerDown,
      relMouseMovePointerEvent,
      absMouseMovePointerEvent,
      updateTouchContextMenuPointer,
      emitWheelDelta,
    ]
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const contextMenuState = touchContextMenuRef.current;
      if (contextMenuState?.phase === 'tracking') {
        if (e.touches.length > 0) {
          contextMenuState.canceled = true;
          return;
        }

        touchContextMenuRef.current = null;
        const touch = Array.from(e.changedTouches).find(
          candidate => candidate.identifier === contextMenuState.identifier
        );
        if (contextMenuState.canceled || !touch) {
          lastClientRef.current = null;
          return;
        }

        const pointerPosition = updateTouchContextMenuPointer(
          contextMenuState,
          touch
        );
        if (
          contextMenuState.maxDistance <
          TOUCH_CONSTANTS.CONTEXT_MENU_SELECTION_DISTANCE
        ) {
          // Ignore an accidental tap so it cannot immediately dismiss the
          // remote menu; keep the navigation gesture available for a retry.
          touchContextMenuRef.current = {
            phase: 'armed',
            expiresAt:
              Date.now() + TOUCH_CONSTANTS.CONTEXT_MENU_NAVIGATION_TIMEOUT,
            pointerClientX: contextMenuState.pointerClientX,
            pointerClientY: contextMenuState.pointerClientY,
          };
          lastClientRef.current = null;
          return;
        }

        const pointerMove = createTouchPointerEvent(
          'pointermove',
          pointerPosition.clientX,
          pointerPosition.clientY,
          0
        );
        if (mode === 'relative') {
          relMouseMovePointerEvent(pointerMove);
          if (relRafIdRef.current !== null) {
            cancelAnimationFrame(relRafIdRef.current);
            relRafIdRef.current = null;
          }
          flushPendingRelMove(0, 0);
        } else {
          cancelPendingAbsMove();
          const hoverPayload = computeAbsPayload(pointerMove);
          if (hoverPayload) {
            lastSent.current = hoverPayload;
            onAbsMove?.(
              hoverPayload.x,
              hoverPayload.y,
              hoverPayload.buttons
            );
          }
        }

        const pointerDown = createTouchPointerEvent(
          'pointerdown',
          pointerPosition.clientX,
          pointerPosition.clientY,
          1
        );
        if (mode === 'relative') {
          relPointerDown(pointerDown);
        } else {
          absPointerDown(pointerDown);
        }
        touchLeftButtonDownRef.current = true;

        const timerId = window.setTimeout(() => {
          if (touchEndTimerRef.current === timerId) {
            touchEndTimerRef.current = null;
          }
          const pointerUp = createTouchPointerEvent(
            'pointerup',
            pointerPosition.clientX,
            pointerPosition.clientY,
            0
          );
          if (mode === 'relative') {
            relPointerUp(pointerUp);
            lastClientRef.current = null;
          } else {
            absPointerUp(pointerUp);
          }
          touchLeftButtonDownRef.current = false;
        }, TOUCH_CONSTANTS.BUTTON_RELEASE_DELAY);
        touchEndTimerRef.current = timerId;
        return;
      }

      const twoFingerTap = twoFingerTapRef.current;
      if (twoFingerTap) {
        for (let index = 0; index < e.changedTouches.length; index += 1) {
          const changedTouch = e.changedTouches[index];
          if (!changedTouch) continue;
          const startPoint = twoFingerTap.startPoints.find(
            point => point.identifier === changedTouch.identifier
          );
          if (
            !startPoint ||
            Math.hypot(
              changedTouch.clientX - startPoint.x,
              changedTouch.clientY - startPoint.y
            ) > TOUCH_CONSTANTS.TWO_FINGER_TAP_DISTANCE
          ) {
            twoFingerTap.moved = true;
            break;
          }
        }

        if (e.touches.length > 0) {
          twoFingerTap.scrolling = false;
          return;
        }

        twoFingerTapRef.current = null;
        const isValidRightClick =
          !twoFingerTap.moved &&
          Date.now() - twoFingerTap.startedAt <=
            TOUCH_CONSTANTS.TWO_FINGER_TAP_DELAY;

        if (isValidRightClick) {
          sendTouchRightClick(
            twoFingerTap.centerX,
            twoFingerTap.centerY
          );
        }
        return;
      }

      const touch = e.changedTouches[0];
      if (!touch) return;
      touchStartPointRef.current = null;
      const touchSequence = touchSequenceRef.current;

      // Clear previous touchEnd timer to prevent leaks
      if (touchEndTimerRef.current !== null) {
        window.clearTimeout(touchEndTimerRef.current);
        touchEndTimerRef.current = null;
      }

      if (tapTimeoutRef.current !== null) {
        const timerId = window.setTimeout(
          () => {
            if (touchEndTimerRef.current === timerId) {
              touchEndTimerRef.current = null;
            }
            if (touchSequence !== touchSequenceRef.current) return;
            const pointerEvent = createTouchPointerEvent(
              'pointerup',
              touch.clientX,
              touch.clientY,
              0
            );

            if (mode === 'relative') {
              relPointerUp(pointerEvent);
            } else {
              absPointerUp(pointerEvent);
            }
            touchLeftButtonDownRef.current = false;
          },
          TOUCH_CONSTANTS.DOUBLE_TAP_DELAY / 2 + TOUCH_CONSTANTS.TAP_DELAY_OFFSET
        ) as unknown as number;
        touchEndTimerRef.current = timerId;
      } else if (touchLeftButtonDownRef.current) {
        const pointerEvent = createTouchPointerEvent(
          'pointerup',
          touch.clientX,
          touch.clientY,
          0
        );

        if (mode === 'relative') {
          relPointerUp(pointerEvent);
        } else {
          absPointerUp(pointerEvent);
        }
        touchLeftButtonDownRef.current = false;
      }
    },
    [
      mode,
      onAbsMove,
      relMouseMovePointerEvent,
      flushPendingRelMove,
      cancelPendingAbsMove,
      relPointerDown,
      absPointerDown,
      relPointerUp,
      absPointerUp,
      sendTouchRightClick,
      updateTouchContextMenuPointer,
    ]
  );

  const handleTouchCancel = useCallback(
    (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearPendingTouchState();
      releasePointerState();
    },
    [clearPendingTouchState, releasePointerState]
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      releasePointerState();
    },
    [releasePointerState]
  );

  useEffect(() => {
    if (!enabled) return;
    const v = videoRef.current;
    const isRelativeMouseMode = mode === 'relative';
    if (!v) return;

    recomputeTransform();
    const resizeObs = new ResizeObserver((_entries) => {

      requestAnimationFrame(() => {

        recomputeTransform();
      });
    });
    resizeObs.observe(v);


    if (v.parentElement) {
      resizeObs.observe(v.parentElement);

      if (v.parentElement.parentElement) {
        resizeObs.observe(v.parentElement.parentElement);

      }
    }

    const intersectionObs = new IntersectionObserver(
      () => {
        requestAnimationFrame(() => {
          recomputeTransform();
        });
      },
      { threshold: [0, 0.1, 0.5, 0.9, 1.0] }
    );
    intersectionObs.observe(v);

    const onWindowResize = () => {
      requestAnimationFrame(() => {
        recomputeTransform();
      });
    };
    window.addEventListener('resize', onWindowResize);

    v.addEventListener('loadedmetadata', recomputeTransform);
    const controlSurface = getControlSurface(videoRef);
    const handleSurfaceEnter = () => {
      focusControlSurface(videoRef);
    };
    const handleSurfaceLeave = () => {
      releasePointerState();
    };
    controlSurface?.addEventListener('mouseenter', handleSurfaceEnter);
    controlSurface?.addEventListener('pointermove', handleSurfaceEnter, {
      passive: true,
    });
    controlSurface?.addEventListener('mouseleave', handleSurfaceLeave);

    const targetElement: EventTarget = document;
    targetElement.addEventListener(
      'pointermove',
      isRelativeMouseMode
        ? (relMouseMovePointerEvent as EventListener)
        : (absMouseMovePointerEvent as EventListener),
      { passive: true }
    );
    if (isRelativeMouseMode) {
      targetElement.addEventListener('pointerdown', relPointerDown as EventListener, {
        passive: true,
      });
      targetElement.addEventListener('pointerup', relPointerUp as EventListener, {
        passive: true,
      });
      targetElement.addEventListener('pointercancel', handlePointerCancel as EventListener, {
        passive: true,
      });
    } else {
      targetElement.addEventListener('pointerdown', absPointerDown as EventListener, {
        passive: true,
      });
      targetElement.addEventListener('pointerup', absPointerUp as EventListener, {
        passive: true,
      });
      targetElement.addEventListener('pointercancel', handlePointerCancel as EventListener, {
        passive: true,
      });
    }

    document.addEventListener('wheel', onWheelInternal as EventListener, {
      passive: false,
    });

    const onVis = () => {
      if (document.hidden) {
        clearPendingTouchState();
        releasePointerState();
      }
    };
    const onWindowBlur = () => {
      clearPendingTouchState();
      releasePointerState();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onWindowBlur);

    const onLockChange = () => {
      const locked = document.pointerLockElement === v;
      isLockedRef.current = locked;
      lastClientRef.current = null;
    };
    document.addEventListener('pointerlockchange', onLockChange);

    // Cursor visibility is controlled by the Hide Cursor setting only.
    // const handleVideoClickForPointerLock = () => {
    //   if (isRelativeMouseMode && POINTER_LOCK_AVAILABLE && !isLockedRef.current) {
    //     try {
    //       v.requestPointerLock();
    //     } catch {}
    //   }
    // };
    // v.addEventListener('click', handleVideoClickForPointerLock);

    targetElement.addEventListener('click', handleClick as EventListener);
    targetElement.addEventListener('dblclick', handleDoubleClick as EventListener);
    targetElement.addEventListener('contextmenu', handleRightClick as EventListener);

    v.addEventListener('touchstart', handleTouchStart as EventListener, {
      passive: false,
    });
    v.addEventListener('touchmove', handleTouchMove as EventListener, {
      passive: false,
    });
    v.addEventListener('touchend', handleTouchEnd as EventListener, { passive: false });
    v.addEventListener('touchcancel', handleTouchCancel as EventListener, { passive: false });

    return () => {
      try {
        resizeObs.disconnect();
        intersectionObs.disconnect();
      } catch {}
      v.removeEventListener('loadedmetadata', recomputeTransform);
      controlSurface?.removeEventListener('mouseenter', handleSurfaceEnter);
      controlSurface?.removeEventListener('pointermove', handleSurfaceEnter);
      controlSurface?.removeEventListener('mouseleave', handleSurfaceLeave);
      window.removeEventListener('resize', onWindowResize);

      document.removeEventListener(
        'pointermove',
        relMouseMovePointerEvent as EventListener
      );
      document.removeEventListener(
        'pointermove',
        absMouseMovePointerEvent as EventListener
      );
      document.removeEventListener('pointerdown', relPointerDown as EventListener);
      document.removeEventListener('pointerup', relPointerUp as EventListener);
      document.removeEventListener('pointerdown', absPointerDown as EventListener);
      document.removeEventListener('pointerup', absPointerUp as EventListener);
      document.removeEventListener('pointercancel', handlePointerCancel as EventListener);
      document.removeEventListener('wheel', onWheelInternal as EventListener);
      document.removeEventListener('click', handleClick as EventListener);
      document.removeEventListener('dblclick', handleDoubleClick as EventListener);
      document.removeEventListener('contextmenu', handleRightClick as EventListener);
      // v.removeEventListener('click', handleVideoClickForPointerLock);

      v.removeEventListener('touchstart', handleTouchStart as EventListener);
      v.removeEventListener('touchmove', handleTouchMove as EventListener);
      v.removeEventListener('touchend', handleTouchEnd as EventListener);
      v.removeEventListener('touchcancel', handleTouchCancel as EventListener);

      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('pointerlockchange', onLockChange);

      if (wheelBlockTimerRef.current) {
        window.clearTimeout(wheelBlockTimerRef.current);
        wheelBlockTimerRef.current = null;
      }
      blockWheelEventRef.current = false;
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      const hadActiveTouchButton =
        touchLeftButtonDownRef.current ||
        touchRightClickTimerRef.current !== null;
      clearPendingTouchState();
      if (hadActiveTouchButton) {
        releasePointerState();
      }
    };
  }, [
    videoRef,
    recomputeTransform,
    absMouseMovePointerEvent,
    relMouseMovePointerEvent,
    absPointerDown,
    absPointerUp,
    relPointerDown,
    relPointerUp,
    releasePointerState,
    handlePointerCancel,
    clearPendingTouchState,
    onWheelInternal,
    handleClick,
    handleDoubleClick,
    handleRightClick,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    mode,
    enabled,
    throttleMs,
  ]);

  useEffect(() => {
    if (!enabled || !jiggler) {
      if (jigglerTimer.current) {
        clearTimeout(jigglerTimer.current);
        jigglerTimer.current = null;
      }
      return;
    }

    if (jigglerTimer.current) {
      clearTimeout(jigglerTimer.current);
      jigglerTimer.current = null;
    }

    const scheduleJiggle = () => {
      jigglerTimer.current = window.setTimeout(() => {
        if (document.hidden) {
          scheduleJiggle();
          return;
        }
        if (mode === 'relative' ? !onRelMove : !onAbsMove) {
          scheduleJiggle();
          return;
        }
        const now = Date.now();
        if (now - lastActivityTs.current < JIGGLER_CONSTANTS.IDLE_MS) {
          scheduleJiggle();
          return;
        }

        try {
          // Clear previous jiggler reset timer
          if (jigglerResetTimerRef.current) {
            clearTimeout(jigglerResetTimerRef.current);
            jigglerResetTimerRef.current = null;
          }

          if (mode === 'relative' && onRelMove) {
            onRelMove({ dx: JIGGLER_CONSTANTS.AMPLITUDE, dy: 0, buttons: 0, x: JIGGLER_CONSTANTS.AMPLITUDE, y: 0 });
            jigglerResetTimerRef.current = window.setTimeout(
              () => {
                jigglerResetTimerRef.current = null;
                onRelMove({ dx: -JIGGLER_CONSTANTS.AMPLITUDE, dy: 0, buttons: 0, x: -JIGGLER_CONSTANTS.AMPLITUDE, y: 0 });
              },
              JIGGLER_CONSTANTS.RESET_DELAY
            ) as unknown as number;
          } else if (onAbsMove) {
            const t = transform.current;
            const centerX = Math.round(((t.vw - 1) / 2 / (t.vw - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE);
            const centerY = Math.round(((t.vh - 1) / 2 / (t.vh - 1)) * MOUSE_CONSTANTS.MAX_COORDINATE);
            const base = lastSent.current ??
              latestPointer.current ?? { x: centerX, y: centerY, buttons: 0 };
            const x1 = Math.max(0, Math.min(MOUSE_CONSTANTS.MAX_COORDINATE, base.x + JIGGLER_CONSTANTS.AMPLITUDE));
            const y1 = base.y;
            const x2 = Math.max(0, Math.min(MOUSE_CONSTANTS.MAX_COORDINATE, base.x));
            const y2 = base.y;
            onAbsMove(x1, y1, 0);
            jigglerResetTimerRef.current = window.setTimeout(
              () => {
                jigglerResetTimerRef.current = null;
                onAbsMove(x2, y2, 0);
              },
              JIGGLER_CONSTANTS.RESET_DELAY
            ) as unknown as number;
          }
        } catch {
          /* ignore */
        }
        scheduleJiggle();
      }, JIGGLER_CONSTANTS.PERIOD_MS) as unknown as number;
    };

    scheduleJiggle();

    return () => {
      if (jigglerTimer.current) {
        clearTimeout(jigglerTimer.current);
        jigglerTimer.current = null;
      }
      // Also clear the jiggler reset timer
      if (jigglerResetTimerRef.current) {
        clearTimeout(jigglerResetTimerRef.current);
        jigglerResetTimerRef.current = null;
      }
    };
  }, [
    enabled,
    jiggler,
    onRelMove,
    onAbsMove,
    mode,
    transform,
    lastActivityTs,
    lastSent,
    latestPointer,
  ]);
}
