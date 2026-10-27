/**
 * ArkKVM Terminal Component
 * A WebRTC-based terminal with adaptive theming and advanced input handling.
 */
import '@xterm/xterm/css/xterm.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useXTerm } from 'react-xtermjs';

// xtermjs addons
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';

import { IconLessen, IconMagnify } from '@/assets/icons';
import { Button } from '@/components';
import { useUiStore } from '@/stores';
import { createLogger } from '@/utils/logger';

const debug = createLogger('XtermTerminal');
const hasWebGL2 =
  typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2');
const terminalChannelIds = new WeakMap<RTCDataChannel, number>();
let terminalChannelSeq = 0;

const getTerminalChannelId = (channel?: RTCDataChannel): number | null => {
  if (!channel) return null;
  const cached = terminalChannelIds.get(channel);
  if (cached) return cached;
  terminalChannelSeq += 1;
  terminalChannelIds.set(channel, terminalChannelSeq);
  return terminalChannelSeq;
};

const getTerminalChannelInfo = (channel?: RTCDataChannel) => ({
  localId: getTerminalChannelId(channel),
  label: channel?.label,
  readyState: channel?.readyState,
  rtcId: channel?.id,
  ordered: channel?.ordered,
  negotiated: channel?.negotiated,
  protocol: channel?.protocol,
});

const logTerminalChannel = (
  event: string,
  channel?: RTCDataChannel,
  extra?: Record<string, unknown>
) => {
  debug.info('[XtermTerminal]', event, {
    ...getTerminalChannelInfo(channel),
    ...extra,
  });
};

/** Extract color tokens from CSS custom properties for live theming */
const extractThemeFromDOM = (): Record<string, string> => {
  const rootStyles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string) =>
    rootStyles.getPropertyValue(name).trim() || fallback;

  return {
    background: getVar('--bg-secondary', '#171717'),
    foreground: getVar('--text-color', '#E0E0E0'),
    cursor: getVar('--text-color', '#FF6B6B'),
    cursorAccent: getVar('--btn-outline-bg', '#3F3F46'),
    // High-contrast Tango-inspired palette for better htop/tool visibility
    black: '#000000',
    red: '#CC0000',
    green: '#4E9A06',
    yellow: '#C4A000',
    blue: getVar('--btn-outline-bg', '#3465A4'),
    magenta: '#75507B',
    cyan: '#06989A',
    white: getVar('--text-color', '#D3D7CF'),
    brightBlack: getVar('--bg-primary', '#555753'),
    brightRed: '#EF2929',
    brightGreen: '#8AE234',
    brightYellow: '#FCE94F',
    brightBlue: getVar('--text-color', '#729FCF'),
    brightMagenta: '#AD7FA8',
    brightCyan: '#34E2E2',
    brightWhite: getVar('--text-color', '#EEEEEC'),
  };
};

/** xterm.js configuration options */
const XTERM_OPTIONS = {
  theme: extractThemeFromDOM(),
  // Use system fonts first to ensure correct width calculation
  // 'Fira Code' is preferred but may not be loaded when fit() runs
  fontFamily: "'SF Mono', 'Cascadia Mono', 'Consolas', 'Menlo', 'Monaco', 'Courier New', monospace",
  fontSize: 13,
  fontWeight: 400,
  fontWeightBold: 700,
  allowProposedApi: true,
  scrollback: 1000,
  cursorBlink: true,
  smoothScrollDuration: 100,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  convertEol: true,
  scrollOnUserInput: true,
  linuxMode: false,
  cursorStyle: 'block',
  rendererType: 'canvas',
} as const;

/** Typography scale constraints */
const FONT_SCALE = {
  default: 13,
  min: 10,
  max: 22,
} as const;

/** Available terminal session types */
type SessionMode = 'terminal' | 'serial' | 'shell' | 'none';

/** Props for the XtermTerminal component - supports both new and legacy naming */
interface XtermTerminalProps {
  /** Header title displayed in the toolbar (legacy: title) */
  headerTitle?: string;
  /** @deprecated Use headerTitle instead */
  title?: string;
  /** WebRTC data channel for bidirectional communication (legacy: dataChannel) */
  channel?: RTCDataChannel;
  /** @deprecated Use channel instead */
  dataChannel?: RTCDataChannel;
  /** Terminal session type (legacy: type) */
  sessionMode?: SessionMode;
  /** @deprecated Use sessionMode instead */
  type?: SessionMode;
  /** Whether to expand to fill parent container height (legacy: fillHeight) */
  expandToFill?: boolean;
  /** @deprecated Use expandToFill instead */
  fillHeight?: boolean;
  /** Whether terminal is in fullscreen overlay mode (legacy: isOverlay) */
  fullscreen?: boolean;
  /** @deprecated Use fullscreen instead */
  isOverlay?: boolean;
  /** Callback when overlay mode is toggled (legacy: onToggleOverlay) */
  onFullscreenToggle?: () => void;
  /** @deprecated Use onFullscreenToggle instead */
  onToggleOverlay?: () => void;
  /** Request an outer WebRTC reconnect when the terminal channel opens but never receives data. */
  onReconnectRequest?: () => void;
}

const XtermTerminal: FC<XtermTerminalProps> = props => {
  // Normalize props for backward compatibility
  const headerTitle = props.headerTitle ?? props.title ?? 'Terminal';
  const channel = props.channel ?? props.dataChannel;
  const sessionMode = props.sessionMode ?? props.type ?? 'terminal';
  const expandToFill = props.expandToFill ?? props.fillHeight ?? false;
  const fullscreen = props.fullscreen ?? props.isOverlay ?? false;
  const onFullscreenToggle = props.onFullscreenToggle ?? props.onToggleOverlay;
  const onReconnectRequest = props.onReconnectRequest;
  const isPanelOpen = useUiStore(s => s.visible.terminal);
  const togglePanel = useUiStore(s => s.toggleMain);
  const [fontSize, setFontSize] = useState(FONT_SCALE.default);
  const [channelLifecycleTick, setChannelLifecycleTick] = useState(0);
  const [viewportBoundHeight, setViewportBoundHeight] = useState<number | null>(null);

  const { instance, ref } = useXTerm({ options: XTERM_OPTIONS });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const skipNextCtrlCFromOnDataRef = useRef(false);
  const viewportBoundHeightRef = useRef<number | null>(null);
  const keyboardScrollTimerRef = useRef<number | null>(null);
  const initializedChannelRef = useRef<RTCDataChannel | null>(null);
  const hasReceivedTerminalMessageRef = useRef(false);
  const recoveryRequestedChannelRef = useRef<RTCDataChannel | null>(null);

  const scrollTerminalInputIntoView = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const target = ref.current ?? containerRef.current;
      if (!target) return;
      try {
        target.scrollIntoView({
          block: 'end',
          inline: 'nearest',
          behavior,
        });
      } catch {
        target.scrollIntoView(false);
      }
    },
    [ref]
  );

  const clearTerminalView = useCallback(() => {
    if (!instance) return;
    try {
      instance.write('\u001b[2J\u001b[3J\u001b[H');
    } catch {}
  }, [instance]);

  const focusTerminal = useCallback(() => {
    if (!instance) return;
    try {
      instance.focus();
      window.setTimeout(() => scrollTerminalInputIntoView('smooth'), 80);
    } catch {}
  }, [instance, scrollTerminalInputIntoView]);

  /** Encode string to ArrayBuffer for WebRTC transmission */
  const encodeToBuffer = useCallback((text: string): ArrayBuffer => {
    return new TextEncoder().encode(text).buffer;
  }, []);

  /** Send SIGINT (Ctrl+C) via data channel for process interruption */
  const emitSigInt = useCallback((): boolean => {
    if (sessionMode !== 'terminal') return false;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      skipNextCtrlCFromOnDataRef.current = true;
      const payload = encodeToBuffer('\u0003');

      channel.send(payload);
      return true;
    } catch {
      skipNextCtrlCFromOnDataRef.current = false;
      return false;
    }
  }, [channel, sessionMode, encodeToBuffer]);

  /** Trigger process interruption */
  const interruptProcess = useCallback(() => {
    emitSigInt();
  }, [emitSigInt]);

  /** Track last reported terminal dimensions to avoid redundant resize RPCs */
  const lastReportedSize = useRef<{ rows: number; cols: number } | null>(null);
  /** Debounce timer for resize events */
  const resizeDebounceTimer = useRef<number | null>(null);
  /**
   * Post-resize prompt deduplication flag.
   * After SIGWINCH, line-edit-less shells (busybox ash etc.) emit "\n<prompt>".
   * We rewrite the first "\r?\n" to "\r\x1b[K" so the new prompt overwrites
   * the existing one instead of creating a duplicate line.
   */
  const promptDedupDeadline = useRef<number | null>(null);

  const sendTerminalSizeNow = useCallback(
    (reason: string, options?: { force?: boolean }) => {
      if (!instance) return false;
      if (!channel || channel.readyState !== 'open') return false;
      const rows = instance.rows;
      const cols = instance.cols;
      const last = lastReportedSize.current;
      if (!options?.force && last && last.rows === rows && last.cols === cols) {
        return false;
      }
      try {
        channel.send(JSON.stringify({ rows, cols }));
        logTerminalChannel('terminal size sent', channel, { reason, rows, cols });
        lastReportedSize.current = { rows, cols };
        promptDedupDeadline.current = Date.now() + 1500;
        return true;
      } catch (err) {
        debug.warn('[XtermTerminal] terminal size send failed', {
          ...getTerminalChannelInfo(channel),
          reason,
          rows,
          cols,
          error: err,
        });
        return false;
      }
    },
    [channel, instance]
  );

  /** Debounced terminal resize reporter */
  const reportTerminalSize = useCallback(() => {
    if (!instance) return;
    if (!channel || channel.readyState !== 'open') return;
    if (resizeDebounceTimer.current != null) {
      window.clearTimeout(resizeDebounceTimer.current);
    }
    resizeDebounceTimer.current = window.setTimeout(() => {
      resizeDebounceTimer.current = null;
      sendTerminalSizeNow('resize_debounce');
    }, 300);
  }, [channel, instance, sendTerminalSizeNow]);

  /** Write incoming data with post-resize prompt deduplication */
  const writeToTerminal = useCallback(
    (chunk: string) => {
      if (!instance) return;
      const deadline = promptDedupDeadline.current;
      if (!deadline || Date.now() >= deadline) {
        if (deadline) promptDedupDeadline.current = null;
        instance.write(chunk);
        return;
      }
      const newlineMatch = chunk.match(/\r?\n/);
      if (!newlineMatch || newlineMatch.index === undefined) {
        instance.write(chunk);
        return;
      }
      promptDedupDeadline.current = null;
      const before = chunk.slice(0, newlineMatch.index);
      const after = chunk.slice(newlineMatch.index + newlineMatch[0].length);
      instance.write(before + '\r\x1b[K' + after);
    },
    [instance]
  );
  /** Cleanup timers on unmount */
  useEffect(() => {
    return () => {
      if (resizeDebounceTimer.current != null) {
        window.clearTimeout(resizeDebounceTimer.current);
        resizeDebounceTimer.current = null;
      }
      promptDedupDeadline.current = null;
    };
  }, []);

  /** Close terminal panel and cleanup */
  const dismissTerminal = useCallback(() => {
    interruptProcess();
    clearTerminalView();
    togglePanel('terminal');
  }, [clearTerminalView, interruptProcess, togglePanel]);

  /** Auto-focus terminal when opened */
  useEffect(() => {
    if (!isPanelOpen || !instance) return;
    const timer = setTimeout(focusTerminal, 50);
    return () => clearTimeout(timer);
  }, [focusTerminal, isPanelOpen, instance]);

  /** Sync theme when CSS variables may have changed */
  useEffect(() => {
    if (!instance) return;
    try {
      instance.options.theme = extractThemeFromDOM();
    } catch (err) {
      debug.warn('Theme update failed', err);
    }
  }, [instance]);

  useEffect(() => {
    logTerminalChannel('channel prop changed', channel, {
      isPanelOpen,
      hasInstance: Boolean(instance),
    });
  }, [channel, instance, isPanelOpen]);

  useEffect(() => {
    if (!instance || !isPanelOpen) return;

    const dataSub = instance.onData((data: string) => {
      if (data === '\u0003' && skipNextCtrlCFromOnDataRef.current) {
        skipNextCtrlCFromOnDataRef.current = false;
        return;
      }
      if (!channel) {
        logTerminalChannel('input blocked: missing channel', channel, {
          bytes: data.length,
        });
        return;
      }
      if (channel.readyState !== 'open') {
        logTerminalChannel('input blocked: channel not open', channel, {
          bytes: data.length,
        });
        return;
      }
      try {
        if (!hasReceivedTerminalMessageRef.current) {
          sendTerminalSizeNow('input_before_first_message', { force: true });
        }
        channel.send(encodeToBuffer(data));
        logTerminalChannel('input sent', channel, {
          bytes: data.length,
          bufferedAmount: channel.bufferedAmount,
          receivedTerminalMessage: hasReceivedTerminalMessageRef.current,
        });
      } catch (err) {
        debug.warn('[XtermTerminal] input send failed', {
          ...getTerminalChannelInfo(channel),
          error: err,
        });
      }
    });

    return () => {
      dataSub.dispose();
    };
  }, [channel, encodeToBuffer, instance, isPanelOpen, sendTerminalSizeNow]);

  /** Main data channel connection handler */
  const channelState = channel?.readyState ?? 'closed';
  useEffect(() => {
    if (!instance || !isPanelOpen) {
      logTerminalChannel('connection effect skipped', channel, {
        hasInstance: Boolean(instance),
        isPanelOpen,
      });
      return;
    }

    if (!channel) {
      logTerminalChannel('connection waiting: missing channel', channel);
      return;
    }

    logTerminalChannel('connection effect start', channel, {
      channelState,
      channelLifecycleTick,
    });

    // If channel is not open yet, listen for open event then re-trigger
    if (channelState !== 'open') {
      const handleStateChange = (event: Event) => {
        logTerminalChannel(`channel ${event.type}`, channel);
        setChannelLifecycleTick(t => t + 1);
      };
      if (channel.readyState === 'open') {
        logTerminalChannel('channel became open during effect', channel);
        setChannelLifecycleTick(t => t + 1);
        return;
      }
      channel.addEventListener('open', handleStateChange, { once: true });
      channel.addEventListener('close', handleStateChange, { once: true });
      channel.addEventListener('error', handleStateChange, { once: true });
      return () => {
        channel.removeEventListener('open', handleStateChange);
        channel.removeEventListener('close', handleStateChange);
        channel.removeEventListener('error', handleStateChange);
      };
    }

    const shouldResetTerminal = initializedChannelRef.current !== channel;
    if (shouldResetTerminal) {
      initializedChannelRef.current = channel;
      hasReceivedTerminalMessageRef.current = false;
      recoveryRequestedChannelRef.current = null;
      lastReportedSize.current = null;
      promptDedupDeadline.current = null;
      skipNextCtrlCFromOnDataRef.current = false;
    }

    const handleStateChange = (event: Event) => {
      logTerminalChannel(`channel ${event.type}`, channel);
      setChannelLifecycleTick(t => t + 1);
    };
    channel.addEventListener('close', handleStateChange, { once: true });
    channel.addEventListener('error', handleStateChange, { once: true });

    const refitAndFocus = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {}
      reportTerminalSize();
      focusTerminal();
    };
    requestAnimationFrame(refitAndFocus);
    const focusTimer = window.setTimeout(refitAndFocus, 80);

    const bootstrapTerminal = (reason: string) => {
      if (channel.readyState !== 'open') return;
      if (hasReceivedTerminalMessageRef.current) return;
      try {
        channel.send(encodeToBuffer('clear\r'));
        logTerminalChannel('terminal bootstrap sent', channel, { reason });
      } catch (err) {
        debug.warn('[XtermTerminal] terminal bootstrap send failed', {
          ...getTerminalChannelInfo(channel),
          reason,
          error: err,
        });
      }
      lastReportedSize.current = null;
      reportTerminalSize();
    };

    const bootstrapTimers: number[] = [];
    if (shouldResetTerminal) {
      clearTerminalView();
      [0, 300, 1000, 2000, 4000].forEach((delayMs) => {
        const timer = window.setTimeout(() => {
          bootstrapTerminal(`channel_reset_${delayMs}`);
        }, delayMs);
        bootstrapTimers.push(timer);
      });
    }

    const terminalStallTimer = window.setTimeout(() => {
      if (hasReceivedTerminalMessageRef.current) return;
      if (channel.readyState !== 'open') return;
      if (recoveryRequestedChannelRef.current === channel) return;
      recoveryRequestedChannelRef.current = channel;
      logTerminalChannel('terminal stalled: requesting reconnect', channel);
      onReconnectRequest?.();
    }, 6500);

    const abortCtrl = new AbortController();
    try {
      channel.binaryType = 'arraybuffer';
    } catch {}
    const binaryMode = channel.binaryType;

    channel.addEventListener(
      'message',
      (event: MessageEvent) => {
        const utf8Decoder = new TextDecoder('utf-8');
        hasReceivedTerminalMessageRef.current = true;
        logTerminalChannel('message received', channel, {
          dataType:
            event.data instanceof ArrayBuffer
              ? 'arraybuffer'
              : event.data instanceof Blob
                ? 'blob'
                : typeof event.data,
          bytes:
            event.data instanceof ArrayBuffer
              ? event.data.byteLength
              : typeof event.data === 'string'
                ? event.data.length
                : undefined,
        });
        if (binaryMode === 'arraybuffer' && event.data instanceof ArrayBuffer) {
          writeToTerminal(utf8Decoder.decode(new Uint8Array(event.data)));
        } else if (binaryMode === 'blob' && event.data instanceof Blob) {
          const fileReader = new FileReader();
          fileReader.onload = () => {
            if (!fileReader.result) return;
            writeToTerminal(utf8Decoder.decode(new Uint8Array(fileReader.result as ArrayBuffer)));
          };
          fileReader.readAsArrayBuffer(event.data);
        } else if (typeof event.data === 'string') {
          writeToTerminal(event.data);
        }
      },
      { signal: abortCtrl.signal }
    );

    const keySub = instance.onKey((event: { domEvent: KeyboardEvent }) => {
      const { domEvent } = event;
      logTerminalChannel('key event', channel, {
        key: domEvent.key,
        ctrlKey: domEvent.ctrlKey,
        metaKey: domEvent.metaKey,
        shiftKey: domEvent.shiftKey,
      });
      // Smart Ctrl+C: copy if selection exists, else send SIGINT
      if (
        (domEvent.ctrlKey || domEvent.metaKey) &&
        !domEvent.shiftKey &&
        domEvent.key.toLowerCase() === 'c'
      ) {
        const hasSelection = instance.hasSelection?.() ?? false;
        if (!hasSelection && emitSigInt()) {
          domEvent.preventDefault();
          domEvent.stopPropagation();
        }
      }
      // Escape closes terminal
      if (domEvent.key === 'Escape') {
        dismissTerminal();
        domEvent.preventDefault();
      }
    });

    reportTerminalSize();

    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(terminalStallTimer);
      bootstrapTimers.forEach(timer => window.clearTimeout(timer));
      channel.removeEventListener('close', handleStateChange);
      channel.removeEventListener('error', handleStateChange);
      abortCtrl.abort();
      keySub.dispose();
    };
  }, [
    channel,
    channelState,
    channelLifecycleTick,
    instance,
    isPanelOpen,
    emitSigInt,
    dismissTerminal,
    clearTerminalView,
    encodeToBuffer,
    focusTerminal,
    reportTerminalSize,
    onReconnectRequest,
    writeToTerminal,
  ]);

  /** Apply font size changes with refit */
  useEffect(() => {
    if (!instance) return;
    try {
      instance.options.fontSize = fontSize;
    } catch {}

    const refitAndReport = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {}
      reportTerminalSize();
    };

    requestAnimationFrame(refitAndReport);
    const timer = window.setTimeout(refitAndReport, 60);
    return () => window.clearTimeout(timer);
  }, [fontSize, instance, reportTerminalSize]);

  /** Initialize xterm.js addons and observers */
  useEffect(() => {
    if (!instance) return;

    const fitter = new FitAddon();
    fitAddonRef.current = fitter;
    instance.loadAddon(fitter);

    instance.loadAddon(new ClipboardAddon());
    instance.loadAddon(new Unicode11Addon());
    instance.loadAddon(new WebLinksAddon());
    instance.unicode.activeVersion = '11';

    if (hasWebGL2) {
      const renderer = new WebglAddon();
      renderer.onContextLoss(() => renderer.dispose());
      instance.loadAddon(renderer);
    }

    const fitAndReport = () => {
      try {
        fitter.fit();
      } catch {}
      reportTerminalSize();
    };

    requestAnimationFrame(fitAndReport);
    const initialFitTimer = window.setTimeout(fitAndReport, 250);

    const elementObserver =
      ref.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(fitAndReport)
        : null;
    if (elementObserver && ref.current) {
      elementObserver.observe(ref.current);
    }

    const onWindowResize = () => {
      fitter.fit();
      reportTerminalSize();
    };

    window.addEventListener('resize', onWindowResize);
    window.visualViewport?.addEventListener('resize', onWindowResize);
    return () => {
      window.clearTimeout(initialFitTimer);
      elementObserver?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.visualViewport?.removeEventListener('resize', onWindowResize);
      fitAddonRef.current = null;
    };
  }, [instance, ref, reportTerminalSize]);

  /** Refit when terminal becomes visible */
  useEffect(() => {
    if (!isPanelOpen) return;
    const refit = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {}
    };
    requestAnimationFrame(refit);
    const timer = window.setTimeout(refit, 320);
    return () => window.clearTimeout(timer);
  }, [isPanelOpen]);

  /** Keep the docked terminal above the mobile soft keyboard. */
  useEffect(() => {
    if (!isPanelOpen || fullscreen) {
      viewportBoundHeightRef.current = null;
      setViewportBoundHeight(null);
      return;
    }

    const updateViewportBoundHeight = (shouldScroll: boolean) => {
      const container = containerRef.current;
      const viewport = window.visualViewport;
      if (!container || !viewport) {
        viewportBoundHeightRef.current = null;
        setViewportBoundHeight(null);
        return;
      }

      const rect = container.getBoundingClientRect();
      const viewportBottom = viewport.offsetTop + viewport.height;
      const availableHeight = Math.floor(viewportBottom - rect.top - 8);
      const nextHeight = availableHeight > 0 ? Math.max(160, availableHeight) : null;
      if (viewportBoundHeightRef.current !== nextHeight) {
        viewportBoundHeightRef.current = nextHeight;
        setViewportBoundHeight(nextHeight);
      }
      if (shouldScroll) {
        scrollTerminalInputIntoView('auto');
      }
    };

    const scheduleViewportUpdate = () => {
      if (keyboardScrollTimerRef.current != null) {
        window.clearTimeout(keyboardScrollTimerRef.current);
      }
      keyboardScrollTimerRef.current = window.setTimeout(() => {
        keyboardScrollTimerRef.current = null;
        updateViewportBoundHeight(true);
      }, 1000);
    };

    updateViewportBoundHeight(false);
    window.addEventListener('resize', scheduleViewportUpdate);
    window.visualViewport?.addEventListener('resize', scheduleViewportUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleViewportUpdate);

    return () => {
      if (keyboardScrollTimerRef.current != null) {
        window.clearTimeout(keyboardScrollTimerRef.current);
        keyboardScrollTimerRef.current = null;
      }
      window.removeEventListener('resize', scheduleViewportUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleViewportUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleViewportUpdate);
    };
  }, [fullscreen, isPanelOpen, scrollTerminalInputIntoView]);

  /** Typography controls */
  const zoomOut = useCallback(() => {
    setFontSize(prev => Math.max(FONT_SCALE.min, prev - 1));
  }, []);

  const zoomIn = useCallback(() => {
    setFontSize(prev => Math.min(FONT_SCALE.max, prev + 1));
  }, []);

  const zoomReset = useCallback(() => {
    setFontSize(FONT_SCALE.default);
  }, []);

  /** Cleanup on unmount */
  useEffect(() => {
    return () => {
      interruptProcess();
      clearTerminalView();
    };
  }, [clearTerminalView, interruptProcess]);

  /**
   * Refit when overlay mode toggles so the visible grid matches the new container.
   * reportTerminalSize is debounced/deduped internally, so rapid toggles collapse
   * into a single final resize RPC (and hence at most one shell prompt redraw).
   */
  useEffect(() => {
    if (!instance) return;
    const fitTimer = window.setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        reportTerminalSize();
      } catch {}
    }, 50);
    return () => window.clearTimeout(fitTimer);
  }, [fullscreen, instance, reportTerminalSize]);

  if (!isPanelOpen) return null;

  /**
   * Layout strategy:
   * - Fullscreen: fixed position covering viewport (overlay mode)
   * - Expanded: fill parent container (docked mode with expandToFill)
   * - Default: fixed 344px height when parent has no constraints
   */
  const containerClasses = fullscreen
    ? 'fixed inset-0 z-[40] h-[100dvh] w-[100dvw] max-w-[100dvw] overflow-hidden bg-[var(--bg-secondary)]'
    : expandToFill
      ? 'h-full min-w-0 w-full max-w-full overflow-hidden'
      : 'min-w-0 w-full max-w-full overflow-hidden';
  const containerStyles = fullscreen
    ? undefined
    : expandToFill
      ? viewportBoundHeight
        ? ({ maxHeight: `${viewportBoundHeight}px` } as const)
        : undefined
      : ({
          height: viewportBoundHeight ? `${Math.min(344, viewportBoundHeight)}px` : '344px',
        } as const);

  return (
    <div
      ref={containerRef}
      className={containerClasses}
      style={containerStyles}
      onKeyDown={e => e.stopPropagation()}
      onKeyUp={e => e.stopPropagation()}
    >
      <div className="h-full w-full min-w-0 overflow-hidden bg-[var(--bg-secondary)]">
        <div className="relative flex min-w-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--btn-outline-bg)] px-2 py-2 sm:px-4">
          <h2 className="min-w-[92px] max-w-[45%] truncate select-none font-sans text-[13px] font-medium text-[var(--text-color)] sm:max-w-none">
            {headerTitle}
          </h2>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto overscroll-x-contain sm:gap-2">
            <Button
              size="XS"
              variant="light"
              className="shrink-0"
              onClick={onFullscreenToggle}
              title={fullscreen ? 'Dock terminal' : 'Cover screen with terminal'}
            >
              {fullscreen ? <IconLessen /> : <IconMagnify />}
            </Button>
            <Button size="XS" variant="light" className="shrink-0" onClick={zoomOut}>
              A-
            </Button>
            <Button size="XS" variant="light" className="shrink-0" onClick={zoomReset}>
              {Math.round((fontSize / FONT_SCALE.default) * 100)}%
            </Button>
            <Button size="XS" variant="light" className="shrink-0" onClick={zoomIn}>
              A+
            </Button>
            <Button size="XS" variant="light" className="shrink-0" onClick={dismissTerminal}>
              Hide
            </Button>
          </div>
        </div>
        <div className="h-[calc(100%-36px)] min-w-0 overflow-hidden">
          <div
            ref={ref}
            translate="no"
            className="notranslate h-full w-full box-border overflow-hidden py-1 pl-2 pr-1 sm:p-0"
            onClick={focusTerminal}
            onFocus={() => scrollTerminalInputIntoView('smooth')}
          />
        </div>
      </div>
    </div>
  );
};

/** Export with original name for backward compatibility */
export default XtermTerminal;
