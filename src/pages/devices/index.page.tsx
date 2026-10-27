/**
 * KVM Device Control Page
 *
 * Main interface for remote device control via KVM (Keyboard, Video, Mouse).
 * Supports both device-direct and cloud modes.
 *
 * @module pages/devices
 */

// ============================================================================
// External Dependencies
// ============================================================================
import { createLogger } from '@/utils/logger';
import { normalizeDeviceId } from '@/utils/security';
import { getCloudDeviceVersionUrl } from '@/utils/cloudDeviceVersion';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

// ============================================================================
// Internal Dependencies - API & Services
// ============================================================================
import { request } from '@/api';
import type { kvmLocalDevice, kvmDeviceStatus } from '@/api/types';
import { fetchDeviceSettings } from '@/services/deviceSettings';

// ============================================================================
// Internal Dependencies - Components
// ============================================================================
import {
  AspectRatioContainer,
  Button,
  ConnectionIssuePanel,
  ControlSidebar,
  Dialog,
  DraggablePanel,
  Extension,
  RemoteScreen,
  SessionStatusBar,
  Settings,
  SlidePanel,
  StreamAnalytics,
  SystemUpdateDialog,
  VlanPendingConfirmDialog,
  XtermTerminal,
} from '@/components';
import { ControlLeaseDialog } from '@/components/kvm/ControlLease/ControlLeaseDialog';
import { useControlLease } from '@/components/kvm/ControlLease/useControlLease';
import TopNavbar from '@/components/TopNavbar/TopNavbar';
import ControlToolbar, { type FullScreenData } from '@/components/ControlToolbar';
import { DefaultLoadingOverlay } from '@/components/DefaultLoadingOverlay';
import { type RemoteScreenHandle } from '@/components/kvm/RemoteScreen';
import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog';
import VirtualKeyboard from '@/components/VirtualKeyboard/index.tsx';
import { externalModifierMask, toHidReport } from '@/components/VirtualKeyboard/utils';
import {
  createInitialModifierState,
  HID_MODIFIERS,
  isModifierKey,
  resolveModifierCode,
} from '@/components/VirtualKeyboard/utils/modifierStateManager';
import { FullscreenPortalProvider } from '@/contexts/FullscreenPortalContext';

// ============================================================================
// Internal Dependencies - Hooks
// ============================================================================
import { useInputChannel } from '@/hooks/useInputChannel';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useLongPressEscape } from '@/hooks/useLongPressEscape';
import { useMouseEvents } from '@/hooks/useMouseEvents';
import { usePageTitle } from '@/hooks/usePageTitle';

// ============================================================================
// Internal Dependencies - State Management
// ============================================================================
import { isAnyUiPanelOpen, useAppStore, useRTCStore, useUiStore } from '@/stores';

// ============================================================================
// Internal Dependencies - Utils & Assets
// ============================================================================
import { IconCloud, IconToLeft } from '@/assets/icons';
import { captureDeviceSnapshot } from '@/utils/deviceSnapshot';
import { env } from '@/utils/env';

// ============================================================================
// Types
// ============================================================================
import { ReconnectOverlay } from '@/components/update/ReconnectOverlay';
import { useUpdateCheck } from '@/components/update/SystemUpdateDialog';
import {
  useActiveDeviceSelect,
  useSettingsStore,
  type UsbDeviceConfig,
  defaultUsbDeviceConfig,
} from '@/stores/devicesStore';
import type { PageMeta } from '@/types/page-meta';
import { cn } from '@/utils';

const logger = createLogger('DevicePage');

// ============================================================================
// Page Metadata
// ============================================================================
export const meta: PageMeta = {
  auth: true,
  title: 'device.management',
  path: '/',
  cloudPath: ':v/device/:id',
  target: 'universal',
};

// ============================================================================
// Types & Interfaces
// ============================================================================
type _KeyboardDisplayMode = 'docked' | 'floating';
type _TransceiverMode = 'recvonly' | 'sendrecv';

interface _DeviceConnectionState {
  isChannelReady: boolean;
  peerState: string | undefined;
  usbState: string | undefined;
  hdmiConnectionState: string | undefined;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * KVM Device Control Page Component
 *
 * Provides the main interface for controlling remote devices including:
 * - Real-time video streaming via WebRTC
 * - Keyboard and mouse input forwarding
 * - Virtual keyboard support
 * - Terminal access
 * - Device settings management
 */
const KVMControlPage = () => {
  const { target, signalingUrl } = env;
  const [keyboardDisplayMode, setKeyboardDisplayMode] = useState<'docked' | 'floating'>('docked');
  const { id: rawDeviceId } = useParams();
  const deviceId = normalizeDeviceId(rawDeviceId) || undefined;
  const location = useLocation();

  // Get deviceName from URL query parameter
  const deviceNameFromQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('deviceName');
  }, [location.search]);

  const [deviceName, _setDeviceName] = useState<string>(deviceNameFromQuery || '');

  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const pressCountRef = useRef<Map<string, number>>(new Map()); // Per-key release counter
  const doubleClickTimersRef = useRef<Set<NodeJS.Timeout>>(new Set()); // Track double-click timers
  const getVideoStateTimerRef = useRef<NodeJS.Timeout | null>(null); // Video state debounce timer
  // Keyboard modifier key state (tracks actual key presses)
  const [virtualKeyboardModifierState, setVirtualKeyboardModifierState] =
    useState<ModifierKeysState>(createInitialModifierState());

  // Local state for pressed keys (better performance than global state)
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [showSessionConflictDialog, setShowSessionConflictDialog] = useState(false);
  // Latched once the device hands this window's session to another client
  // (`otherSessionConnected`). While set, no automatic path may reconnect: retaking the
  // session without an explicit user choice kicks the other window, which would retake it
  // in turn, and the two windows would keep fighting over the session.
  const sessionPreemptedRef = useRef(false);
  const showStatusBar = useAppStore(s => s.showStatusBar);

  const keyboardHeight = useUiStore(s => s.keyboardHeight);
  const visibleVirtualKeyboard = useUiStore(s => s.visible.virtualKeyboard);
  const visibleSettings = useUiStore(s => s.visible.settings);

  // Get confirm dialog closeAll method for session conflict handling
  const { closeAll: closeAllConfirmDialogs } = useConfirmDialog();

  // Local helper to manage pressed keys
  const setPressedKey = useCallback(
    (keyCode: string, isPressed: boolean) => {
      if (isPressed) {
        pressedKeysRef.current.add(keyCode);
      } else {
        pressedKeysRef.current.delete(keyCode);
      }
      // Only trigger re-render when virtual keyboard is visible
      if (visibleVirtualKeyboard) {
        forceUpdate();
      }
    },
    [visibleVirtualKeyboard]
  );

  const resetPressedKeys = useCallback(() => {
    pressedKeysRef.current.clear();
    // Only trigger re-render when virtual keyboard is visible
    if (visibleVirtualKeyboard) {
      forceUpdate();
    }
  }, [visibleVirtualKeyboard]);

  const csrfToken = sessionStorage.getItem('csrfToken') || '';
  const serverUrl =
    (rawDeviceId !== undefined || target === 'cloud') && !deviceId
      ? ''
      : target === 'cloud'
        ? `${signalingUrl}?id=${encodeURIComponent(deviceId || '')}&token=${encodeURIComponent(token || '')}`
        : `${signalingUrl}${csrfToken ? `?csrf-token=${encodeURIComponent(csrfToken)}` : ''}`;
  const isPasteTextOpen = useUiStore(s => s.isPasteTextOpen);
  const keyboardLanguage = useAppStore(s => s.keyboardLanguage) || 'en-US-qwerty';
  const currentLang = useAppStore(s => s.currentLang);
  const oobeAutoUpdate = useAppStore(state => state.auto_update);
  const setOobeAutoUpdate = useAppStore(state => state.setAutoUpdate);
  const toggleMain = useUiStore(s => s.toggleMain);
  const setKeyboardLanguage = useAppStore(s => s.setKeyboardLanguage);
  const videoWidth = useAppStore(s => s.videoWidth);
  const videoHeight = useAppStore(s => s.videoHeight);
  // Use getState() for setters to avoid re-renders on store updates
  const modifierReleaseMode = useAppStore(s => s.modifierReleaseMode);
  const setVideoResolution = useAppStore.getState().setVideoResolution;
  const setHdmiConnectionState = useAppStore.getState().setHdmiConnectionState;
  const hdmiConnectionState = useAppStore(s => s.hdmiConnectionState);
  const isTerminalVisible = useAppStore(s => s.ui.visible.terminal);
  const setTerminalChannel = useAppStore.getState().rtc.setTerminalChannel;
  const setRpcDataChannel = useAppStore.getState().rtc.setRpcDataChannel;
  const setSerialChannel = useAppStore.getState().rtc.setSerialChannel;
  const setDiskChannel = useAppStore.getState().rtc.setDiskChannel;
  const setRtcField = useAppStore.getState().rtc.setRtcField;
  const resetRTC = useAppStore.getState().rtc.resetRTC;
  const resetHID = useAppStore.getState().resetHID;
  const setContainerSize = useAppStore.getState().setContainerSize;
  const setMouseMove = useAppStore.getState().setMouseMove;
  const setAtxState = useAppStore.getState().setAtxState;
  const clearUploads = useAppStore.getState().clearUploads;

  const terminalChannel = useRTCStore(s => s.terminalChannel);
  const usbState = useAppStore(s => s.usbState);

  const setHidUsbState =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAppStore.getState() as any).setHidUsbState ?? useAppStore.getState().setUsbState;
  const peerConnection = useAppStore(s => s.rtc?.peerConnection);
  const peerState = useAppStore(s => s.rtc?.peerConnectionState ?? 'disconnected');

  const [_transceiverMode, _setTransceiverMode] = useState<'recvonly' | 'sendrecv'>('recvonly');
  const remoteScreenRef = useRef<RemoteScreenHandle>(null);
  const mouseVideoRef = useRef<HTMLVideoElement | null>(null);
  const snapshotVideoRef = useRef<HTMLVideoElement | null>(null);
  const closeToolbarPopoversRef = useRef<(() => void) | null>(null);
  // App container ref for fullscreen mode (targets the entire app container)
  const appContainerRef = useRef<HTMLDivElement | null>(null);
  const [keyboardEnabled, setKeyboardEnabled] = useState<boolean>(false);
  const [terminalEnabled, _setTerminalEnabled] = useState<boolean>(false);
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const [_scaleMode, _setScaleMode] = useState<'fit' | 'actual'>('fit');
  const [iceServers, setIceServers] = useState<RTCIceServer[] | undefined>(undefined);
  // Memoize rtcConfig so RemoteScreen / useDesktopRtc don't see a new object
  // identity every render, which would otherwise rebuild the PeerConnection.
  const rtcConfigMemo = useMemo(() => ({ iceServers }), [iceServers]);
  const [terminalOverlay, setTerminalOverlay] = useState<boolean>(false);
  const [terminalMountKey, setTerminalMountKey] = useState<number>(0);
  const terminalChannelRef = useRef<RTCDataChannel | null>(null);
  const [allowWebSocketConnection, setAllowWebSocketConnection] = useState<boolean>(false);
  const [_isMdUp, setIsMdUp] = useState<boolean>(true);
  const [ocrEnabled, setOcrEnabled] = useState<boolean>(false); // OCR feature toggle
  const [isRestarting, setIsRestarting] = useState<boolean>(false);
  const [restartCountdown, setRestartCountdown] = useState<number>(0);
  // Fullscreen paste: floating draggable button + on-demand paste panel inside the fullscreen element
  const [_fsPasteOpen, setFsPasteOpen] = useState<boolean>(false);
  const [_fsPasteInitText, setFsPasteInitText] = useState<string>('');
  const [fsBtnPos, setFsBtnPos] = useState<{ x: number; y: number }>({
    x: 20,
    y: 20,
  });
  const [_fsPanelPos, setFsPanelPos] = useState<{ x: number; y: number } | null>(null);
  const fsBtnDragRef = useRef<{
    dragging: boolean;
    moved: boolean;
    offsetX: number;
    offsetY: number;
  }>({ dragging: false, moved: false, offsetX: 0, offsetY: 0 });
  const fsPanelDragRef = useRef<{
    dragging: boolean;
    offsetX: number;
    offsetY: number;
  }>({ dragging: false, offsetX: 0, offsetY: 0 });

  const visibleTerminal = useUiStore(s => s.visible.terminal);
  const visibleConnectionStats = useUiStore(s => s.visible.connectionStats);
  const visibleExtension = useUiStore(s => s.visible.extension);
  type SidebarActivePanel =
    | 'terminal'
    | 'settings'
    | 'connectionStats'
    | 'extension'
    | 'virtualKeyboard';

  const activeSidebarPanel = useMemo<SidebarActivePanel | undefined>(() => {
    if (visibleTerminal) return 'terminal';
    if (visibleSettings) return 'settings';
    if (visibleConnectionStats) return 'connectionStats';
    if (visibleExtension) return 'extension';
    if (visibleVirtualKeyboard) return 'virtualKeyboard';
    return undefined;
  }, [
    visibleTerminal,
    visibleSettings,
    visibleConnectionStats,
    visibleExtension,
    visibleVirtualKeyboard,
  ]);

  const setKeyboardLedState = useAppStore.getState().ui.setKeyboardLedState;
  const keyboardLedState = useUiStore(s => s.keyboardLedState);
  const setOtaState = useAppStore.getState().update.setOtaState;
  const setModalView = useAppStore.getState().update.setModalView;
  const resetOtaState = useAppStore.getState().update.resetOtaState;
  const closeOtaDialog = useAppStore.getState().update.closeDialog;
  const showReconnectOverlay = useAppStore.getState().update.showReconnectOverlay;
  const hideReconnectOverlay = useAppStore.getState().update.hideReconnectOverlay;
  const isReconnectOverlayVisible = useAppStore(s => s.update.isReconnectOverlayVisible);
  const { getUpdateStatus } = useUpdateCheck();

  // Track the previous value of isReconnectOverlayVisible
  const prevReconnectOverlayVisibleRef = useRef(isReconnectOverlayVisible);

  const reconnectWithGuardRef = useRef<
    (options?: { delayMs?: number; onAfterEnable?: () => void }) => Promise<void>
  >(async () => {});

  const reconnectWithGuard = useCallback(
    async (options?: { delayMs?: number; onAfterEnable?: () => void }) => {
      // A session taken over by another client is not ours to retake until the user says
      // so (see the `otherSessionConnected` handler). Every automatic reconnect path —
      // post-update overlay, restart countdown, network-change redirect — funnels through
      // here, so this one guard covers them all.
      if (sessionPreemptedRef.current) return;

      if (target === 'device' && !deviceId) {
        const localReady = await checkLocalDeviceSetup({ enableWs: false });
        if (!localReady) {
          return;
        }
      }

      remoteScreenRef.current?.disconnect?.();
      resetRTC();
      setAllowWebSocketConnection(false);
      window.setTimeout(() => {
        setAllowWebSocketConnection(true);
        options?.onAfterEnable?.();
      }, options?.delayMs ?? 100);
    },
    [target, deviceId, checkLocalDeviceSetup, resetRTC]
  );

  // Keep ref in sync with latest reconnectWithGuard
  useEffect(() => {
    reconnectWithGuardRef.current = reconnectWithGuard;
  }, [reconnectWithGuard]);

  // Listen for reconnect overlay dismissal and trigger WebRTC reconnect
  useEffect(() => {
    const wasVisible = prevReconnectOverlayVisibleRef.current;
    prevReconnectOverlayVisibleRef.current = isReconnectOverlayVisible;

    // Trigger reconnect when visibility changes from true to false
    if (wasVisible && !isReconnectOverlayVisible) {
      void reconnectWithGuard();
    }
  }, [isReconnectOverlayVisible, reconnectWithGuard]);

  // Drive restart countdown and trigger reconnect when it reaches 0
  useEffect(() => {
    if (!isRestarting || restartCountdown <= 0) return;
    const timer = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          void reconnectWithGuardRef.current({
            delayMs: 200,
            onAfterEnable: () => setIsRestarting(false),
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRestarting]);

  // Subscribe only to required fields to prevent unnecessary re-renders
  const scrollThrottling = useAppStore(s => s.scrollThrottling);
  const enhancement = useAppStore(v => v.enhancement);
  const mouseInputMode = useAppStore(s => s.mouseInputMode);
  const hideCursor = useAppStore(s => s.hideCursor);
  const cursorStyle = useAppStore(s => s.cursorStyle);

  const pressedUsagesRef = useRef<Set<number>>(new Set());
  const pressedModsRef = useRef<Set<string>>(new Set());
  const lastMouseInVideoRef = useRef<boolean>(false);

  const jiggler = useActiveDeviceSelect(state => state.jiggler);

  const inputChannel = useInputChannel();
  const { sendKeyboardReport, sendRelMouseReport, sendAbsMouseReport, sendWheelReport } =
    inputChannel;

  const setKeysDownState =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAppStore.getState() as any).setHidKeysDownState ?? useAppStore.getState().setKeysDownState;
  const controlLayoutMode = useAppStore(s => s.ui.controlLayoutMode);
  const rpcDataChannel = useAppStore(s => s.rtc.rpcDataChannel);
  const controlLease = useControlLease(rpcDataChannel);
  const [send, isChannelReady, sendAsync] = useJsonRpc((request: JsonRpcRequest<MethodName>) => {
    const { method, params } = request;
    if (controlLease.onNotification(method, params)) {
      return;
    }

    switch (method) {
      case 'otherSessionConnected': {
        // Latch first: the teardown below unmounts <RemoteScreen>, and the effects that
        // could reconnect run off this state, so it must be set before anything else.
        sessionPreemptedRef.current = true;
        controlLease.reset();
        // Close all panels, popovers, dialogs and overlays before showing the conflict dialog
        useAppStore.getState().ui.closeAllPanels();
        useAppStore.getState().ui.setIsPasteTextOpen(false);
        closeToolbarPopoversRef.current?.();
        // Close system update dialog and reset OTA state
        closeOtaDialog();
        resetOtaState();
        // Hide reconnect overlay if visible
        hideReconnectOverlay();
        // Close all confirm dialogs (DHCP renew, network settings, etc.)
        closeAllConfirmDialogs();
        setShowSessionConflictDialog(true);
        // Stop the connection instead of letting it come back on its own. `disconnect()`
        // alone is not enough: it only suppresses the socket's close-triggered retry, while
        // react-use-websocket's `retryOnError` path ignores `shouldReconnect`, and the
        // hook's own WebRTC retry effect stays armed. Dropping `allowWebSocketConnection`
        // unmounts <RemoteScreen> and disposes the whole hook — socket, PeerConnection and
        // both retry timers. The connection is only rebuilt once the user confirms the
        // dialog above.
        remoteScreenRef.current?.disconnect?.();
        resetRTC();
        setAllowWebSocketConnection(false);
        break;
      }
      case 'usbState': {
        if (typeof params === 'string') {
          setHidUsbState(params);
        }
        break;
      }
      case 'otaState': {
        // Prioritize error handling
        if (params?.error) {
          resetOtaState();
          setModalView('error');
          return;
        }
        const {
          systemDownloadProgress = 0,
          systemVerificationProgress = 0,
          systemUpdateProgress = 0,
          byUser,
        } = params ?? {};
        setOtaState(prev => ({ ...prev, ...params }));
        const determineModalView = (): void => {
          if (systemUpdateProgress === 100) {
            resetOtaState();
            showReconnectOverlay();
          } else if (systemUpdateProgress > 0) {
            setModalView('preparing');
          } else if (systemVerificationProgress > 0) {
            setModalView('verify');
          } else if (systemDownloadProgress > 0 && byUser) {
            setModalView('download');
          }
        };

        determineModalView();
        break;
      }
      case 'videoInputState': {
        setVideoResolution(params.width, params.height);

        setHdmiConnectionState(params);
        break;
      }
      case 'keyboardLedState': {
        if (params && typeof params === 'object') {
          setKeyboardLedState(params as Parameters<typeof setKeyboardLedState>[0]);
        }
        break;
      }
      case 'keysDownState': {
        break;
      }
      case 'atxState': {
        setAtxState(params);
        break;
      }
      case 'networkState': {
        break;
      }
    }
  });

  // Cache rpc tuple to prevent unnecessary re-renders in child components
  const rpc = useMemo(
    () => [send, isChannelReady, sendAsync] as const,
    [send, isChannelReady, sendAsync]
  );

  const updateMouseInVideo = useCallback((e: globalThis.MouseEvent) => {
    const videoElement = remoteScreenRef.current?.videoElement;
    if (!videoElement) {
      lastMouseInVideoRef.current = false;
      return;
    }
    const rect = videoElement.getBoundingClientRect();
    lastMouseInVideoRef.current =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
  }, []);

  useEffect(() => {
    document.addEventListener('mousemove', updateMouseInVideo);
    return () => {
      document.removeEventListener('mousemove', updateMouseInVideo);
    };
  }, [updateMouseInVideo]);

  // Expose API for browser extensions
  useEffect(() => {
    // Calculate actual channel ready state: force false when disconnected
    const disconnectedStates = ['closed', 'failed', 'disconnected'];
    const actualChannelReady = isChannelReady && !disconnectedStates.includes(peerState || '');
    window.__arkkvm_pc__ = peerConnection;
    window.__arkkvm_rpc__ = {
      send: call => {
        return send(call);
      },
    };

    window.__arkkvm_state__ = {
      isChannelReady: actualChannelReady,
      peerState: peerState || 'unknown',
      usbState: usbState || 'unknown',
      hdmiConnectionState: hdmiConnectionState || 'unknown',
    };

    return () => {
      delete window.__arkkvm_pc__;
      delete window.__arkkvm_rpc__;
      delete window.__arkkvm_state__;
    };
  }, [send, isChannelReady, peerState, usbState, hdmiConnectionState]);

  // Monitor connection state changes and sync HDMI state
  useEffect(() => {
    const disconnectedStates = ['closed', 'failed', 'disconnected'];
    if (peerState && disconnectedStates.includes(peerState)) {
      setHdmiConnectionState({ ready: false, error: 'no_signal' } as Parameters<
        typeof setHdmiConnectionState
      >[0]);
    }
  }, [peerState, setHdmiConnectionState]);

  // Sync RemoteScreen's videoElement to mouseVideoRef for useMouseEvents
  useEffect(() => {
    mouseVideoRef.current = remoteScreenRef.current?.videoElement ?? null;
  }, [remoteScreenRef, peerState]);
  // Check local device setup status
  async function checkLocalDeviceSetup(options?: { enableWs?: boolean }) {
    const { success, data: statusData } = await request.get<kvmDeviceStatus>('/device/status');

    if (!success) return false;

    // Only navigate to welcome on successful response with isSetup: false
    if (statusData?.isSetup === false) {
      navigate('/welcome', { replace: true });
      return false;
    }

    const { success: deviceSuccess, data: deviceData } =
      await request.get<kvmLocalDevice>('/device');
    if (deviceSuccess && deviceData?.deviceId) {
      setActiveDevice(deviceData.deviceId);
      setNestedDeviceSetting(prev => ({
        ...prev,
        authMode: deviceData.authMode,
      }));
      setIceServers([]);
      if (options?.enableWs !== false) {
        setAllowWebSocketConnection(true);
      }
    }
    return true;
  }
  // Fetch ICE configuration (cloud mode)
  const getIceConfig = async () => {
    const { data: iceResp } = await request.post('/webrtc/ice_config', {}, {});

    if (iceResp.iceServers) {
      // Use only server-returned ICE config to avoid duplicate STUN servers
      setIceServers(Array.isArray(iceResp.iceServers) ? iceResp.iceServers : [iceResp.iceServers]);
      setAllowWebSocketConnection(!!iceResp.iceServers);
    }
  };
  useEffect(() => {
    if (rawDeviceId !== undefined && !deviceId) {
      navigate('/devices/list', { replace: true });
      return;
    }
    if (deviceId) {
      getIceConfig();
    } else {
      checkLocalDeviceSetup();
    }
  }, [deviceId, rawDeviceId, navigate]);

  useEffect(() => {
    snapshotVideoRef.current = remoteScreenRef.current?.videoElement ?? null;
  });

  useEffect(() => {
    return () => {
      if (!deviceId) return;
      const video = snapshotVideoRef.current;
      if (video) {
        captureDeviceSnapshot(deviceId, video);
      }
    };
  }, [deviceId]);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const update = () => setIsMdUp(!!mq.matches);
    update();
    try {
      mq.addEventListener('change', update);
    } catch {
      mq.addListener(update);
    }
    return () => {
      try {
        mq.removeEventListener('change', update);
      } catch {
        mq.removeListener(update);
      }
    };
  }, []);
  // Translation hook
  const { t } = useTranslation('common');

  // Use fine-grained selectors to prevent unnecessary re-renders
  const _activeDeviceId = useSettingsStore(s => s.activeDeviceId);
  const devices = useSettingsStore(s => s.devices);
  // Use getState() for setter functions to avoid re-renders
  const setActiveDevice = useSettingsStore.getState().setActiveDevice;
  const _setDeviceSettingById = useSettingsStore.getState().setDeviceSettingById;
  const setNestedDeviceSettingById = useSettingsStore.getState().setNestedDeviceSettingById;
  const setNestedDeviceSetting = useSettingsStore.getState().setNestedDeviceSetting;
  const _createDevice = useSettingsStore.getState().createDevice;
  const authMode = useActiveDeviceSelect(state => state.authMode);
  const hostname = useActiveDeviceSelect(state => state.network?.hostname);
  const isLoading = false;

  // Update page title with hostname
  usePageTitle(hostname);

  // ============================================================================
  // Effects - Data Fetching
  // ============================================================================

  useEffect(() => {
    if (!isChannelReady) {
      return;
    }
    (async () => {
      await getSettings();
      await getVideoStateAsyn();
      await getBaseInfoAsyn();
    })();
  }, [isChannelReady, sendAsync]);
  useEffect(() => {
    if (oobeAutoUpdate && isChannelReady) {
      getUpdateStatus('silent');
      setOobeAutoUpdate(false);
    }
  }, [oobeAutoUpdate, isChannelReady, sendAsync]);

  const getBaseInfoAsyn = useCallback(async () => {
    if (!isChannelReady) {
      return;
    }
    const [
      cameraEmulation,
      microphoneEmulation,
      fileTransfer,
      systemVersionResult,
      autoUpdate,
      uiSwitchResult,
      audioPlaybackResult,
      usbDevicesResult,
      mcpEnabledResult,
    ]: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown] = await Promise.all(
      [
        sendAsync({ method: 'getCameraEmulation' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getMicrophoneEmulation' }, { resultOnly: true }).catch(e => e),
        sendAsync({ method: 'getFileTransfer' }, { resultOnly: true }),
        sendAsync({ method: 'getCurrentVersion', params: { showUI: true } }, { resultOnly: true }),
        sendAsync({ method: 'getAutoUpdateState' }, { resultOnly: true }),
        sendAsync({ method: 'getUiSwitch' }, { resultOnly: true }),
        sendAsync({ method: 'getAudioPlayback' }, { resultOnly: true }),
        sendAsync({ method: 'getUsbDevices' }, { resultOnly: true }),
        sendAsync({ method: 'getMcpEnabled' }, { resultOnly: true }).catch(() => undefined),
      ]
    );
    if (target === 'cloud' && deviceId) {
      const url = getCloudDeviceVersionUrl(window.location.href, deviceId, systemVersionResult);
      if (url) {
        window.location.replace(url);
        return;
      }
    }
    setNestedDeviceSetting(prev => ({
      ...prev,
      mcpEnabled: typeof mcpEnabledResult === 'boolean' ? mcpEnabledResult : undefined,
      microphoneEmulation: microphoneEmulation as boolean,
      cameraEmulation: cameraEmulation as boolean,
      fileTransfer: fileTransfer as boolean,
      autoUpdate: autoUpdate as boolean,
      ...(systemVersionResult || {}),
      audioPlayback: audioPlaybackResult,
      showAudioPlaybackUI: uiSwitchResult?.hdmi_audio,
      usbDeviceConfig: usbDevicesResult
        ? ({ ...defaultUsbDeviceConfig, ...(usbDevicesResult as object) } as UsbDeviceConfig)
        : undefined,
    }));
  }, [sendAsync, isChannelReady, target, deviceId]);
  const getVideoStateAsyn = useCallback(async () => {
    if (!isChannelReady) {
      return;
    }
    if (getVideoStateTimerRef.current) {
      clearTimeout(getVideoStateTimerRef.current);
    }
    getVideoStateTimerRef.current = setTimeout(async () => {
      const { result } = await sendAsync({
        method: 'getVideoState',
      });
      if (result) {
        setVideoResolution(result.width, result.height);
      }
      getVideoStateTimerRef.current = null;
    }, 300);
  }, [sendAsync, isChannelReady]);

  // Cleanup effect for timers and refs to prevent memory leaks
  useEffect(() => {
    return () => {
      // Clear video state timer
      if (getVideoStateTimerRef.current) {
        clearTimeout(getVideoStateTimerRef.current);
        getVideoStateTimerRef.current = null;
      }
      // Clear all double-click timers
      doubleClickTimersRef.current.forEach(timer => clearTimeout(timer));
      doubleClickTimersRef.current.clear();
      // Clear pressCountRef to free memory
      pressCountRef.current.clear();
    };
  }, []);
  const getSettings = async () => {
    try {
      const resp = await sendAsync({ method: 'getDeviceID' });
      if ('result' in resp && resp.result) {
        const id = String(resp.result);

        setActiveDevice(id);
        // Create default settings if device not initialized
        if (!devices[id]) {
          // createDevice(id);
        }
        // Local-first: sync local autoUpdate to backend to avoid server default override
        try {
          const localAuto = devices[id]?.autoUpdate;
          if (typeof localAuto === 'boolean') {
            await sendAsync({
              method: 'setAutoUpdateState',
              params: { enabled: localAuto },
            });
          }
        } catch {}
        // Fetch device settings and write to store
        try {
          const partial = await fetchDeviceSettings(
            sendAsync as Parameters<typeof fetchDeviceSettings>[0]
          );
          setNestedDeviceSettingById(id, prev => ({
            ...prev,
            ...partial,
            autoUpdate:
              typeof prev.autoUpdate === 'boolean'
                ? prev.autoUpdate
                : (partial.autoUpdate ?? false),
            network: { ...prev.network, ...partial.network },
          }));
        } catch {}
      }
    } catch {}
    // Trigger additional queries
    send({ method: 'getVideoState' });
    send({ method: 'getKeyboardLedState' });
  };

  // Fullscreen control
  const onFullScreenClick = async (_event: MouseEvent<SVGSVGElement>, _data?: FullScreenData) => {
    // Use the app container as fullscreen target for better keyboard API support
    const fsTarget =
      appContainerRef.current ?? (remoteScreenRef.current?.videoElement as HTMLElement | undefined);
    if (!fsTarget) return;
    try {
      await fsTarget.requestFullscreen({
        navigationUI: 'show',
      });
      setIsFullScreen(true);

      // Lock keys immediately after fullscreen, within the same user gesture.
      // On Windows Chrome, keyboard.lock() must be called in the same call stack
      // as requestFullscreen(), otherwise Alt+Tab and Win key are not captured.
      const keyboardApi = (
        navigator as Navigator & {
          keyboard?: { lock?: (keyCodes?: string[]) => Promise<void> };
        }
      ).keyboard;
      // Keyboard Lock API requires HTTPS (Secure Context).
      // On HTTP (e.g. http://192.168.x.x), the API is unavailable and
      // system shortcuts like Alt+Tab cannot be captured on Windows.
      await keyboardApi
        ?.lock?.([
          'Escape',
          'Tab',
          'AltLeft',
          'AltRight',
          'ControlLeft',
          'ControlRight',
          'ShiftLeft',
          'ShiftRight',
          'MetaLeft',
          'MetaRight',
          'F1',
          'F2',
          'F3',
          'F4',
          'F5',
          'F6',
          'F7',
          'F8',
          'F9',
          'F10',
          'F11',
          'F12',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Backspace',
          'Delete',
          'Home',
          'End',
          'PageUp',
          'PageDown',
          'Insert',
        ])
        .catch(() => {
          // Silently ignore: either non-HTTPS or unsupported browser
        });
    } catch (error) {
      logger.error('Fullscreen request failed:', error);
    }
  };

  // Exit fullscreen
  const exitFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setIsFullScreen(false);
      }
    } catch (error) {
      logger.error('Exit fullscreen failed:', error);
    }
  };

  // Listen for fullscreen state changes and keyboard events
  useEffect(() => {
    const handleFullscreenChange = () => {
      const el = document.fullscreenElement;

      setIsFullScreen(!!el);
      setPortalContainer(el ? appContainerRef.current : null);
      if (!el) {
        setFsPasteOpen(false);
        setFsPasteInitText('');
        setFsPanelPos(null);
      }
    };

    // Track key press timing
    const keyPressTimes = new Map<string, number>();
    // let lastKeyUpTime = 0;
    // let isFirstKeyDown = true;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Record key down time first
      const key = event.code;
      keyPressTimes.set(key, Date.now());

      // Calculate time between last key up and current key down
      // if (isFirstKeyDown) {
      //   isFirstKeyDown = false;
      // } else if (lastKeyUpTime > 0) {
      //   const interval = Date.now() - lastKeyUpTime;
      // }
      // When any popup/panel is open, don't forward keyboard to remote
      const isAnyUiPanelOpenState = isAnyUiPanelOpen();

      if (isAnyUiPanelOpenState) return;

      // Use composedPath for capture phase to check event path
      const path = event.composedPath();
      for (const el of path) {
        if (!(el instanceof HTMLElement)) continue;

        // Check for editable elements
        const tag = el.tagName?.toLowerCase();
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          el.isContentEditable ||
          el.getAttribute('role') === 'textbox'
        ) {
          return;
        }

        // Check if element has data-kvm-ignore attribute
        if (el.getAttribute('data-kvm-ignore') === 'true') {
          return;
        }

        // Check for common UI components
        const role = el.getAttribute('role');
        if (role === 'dialog' || role === 'alertdialog') return;
        if (
          el.hasAttribute('data-radix-dialog-overlay') ||
          el.hasAttribute('data-radix-popover-content') ||
          el.hasAttribute('data-radix-dropdown-menu-content') ||
          el.hasAttribute('data-slot') ||
          el.hasAttribute('data-panel') ||
          el.hasAttribute('data-sidebar') ||
          el.hasAttribute('data-sheet')
        ) {
          return;
        }
      }

      // A forwarded Tab must not move local focus into an ignored UI element,
      // otherwise its key-up would be filtered and the remote key stays down.
      if (event.code === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }

      // Prevent Ctrl+A from selecting all content in the local browser;
      // it should only be forwarded to the remote device.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
      }

      // In fullscreen mode, prevent browser from intercepting keys that should be
      // forwarded to the remote device (Tab, F-keys, arrow keys, etc.).
      if (document.fullscreenElement) {
        const { code } = event;
        if (
          code === 'Tab' ||
          code === 'Escape' ||
          code === 'Backspace' ||
          code === 'Delete' ||
          code === 'Insert' ||
          code === 'Home' ||
          code === 'End' ||
          code === 'PageUp' ||
          code === 'PageDown' ||
          code === 'ArrowUp' ||
          code === 'ArrowDown' ||
          code === 'ArrowLeft' ||
          code === 'ArrowRight' ||
          (code.startsWith('F') && code.length <= 3 && !isNaN(Number(code.slice(1))))
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }

      const modifiersForReport = {
        ...virtualKeyboardModifierState,
        ControlLeft: Boolean(virtualKeyboardModifierState.ControlLeft || event.ctrlKey),
        ShiftLeft: Boolean(virtualKeyboardModifierState.ShiftLeft || event.shiftKey),
        AltLeft: Boolean(virtualKeyboardModifierState.AltLeft || event.altKey),
        MetaLeft: Boolean(virtualKeyboardModifierState.MetaLeft || event.metaKey),
        AltRight: Boolean(
          (virtualKeyboardModifierState as Record<string, boolean>).AltGr ||
          virtualKeyboardModifierState.AltRight
        ),
      };

      // Infer code from key+location when code is empty (compat for some IMEs/browsers)
      const resolvedCode = event.code || resolveModifierCode(event);
      const report = isModifierKey(event)
        ? toHidReport(event as unknown as KeyboardEvent)
        : toHidReport(event as unknown as KeyboardEvent, modifiersForReport);
      // Physical keyboard AltGr typically appears as AltRight, map to virtual keyboard AltGr
      const keyCode = resolvedCode === 'AltRight' ? 'AltGr' : resolvedCode;

      setKeysDownState(report);

      pressCountRef.current.set(keyCode, 0); // Reset release counter for this key
      // Periodically clean up pressCountRef to prevent memory growth (keep max 50 entries)
      if (pressCountRef.current.size > 50) {
        const entries = Array.from(pressCountRef.current.entries());
        pressCountRef.current.clear();
        // Keep only the last 20 entries
        entries.slice(-20).forEach(([k, v]) => pressCountRef.current.set(k, v));
      }
      sendKeyboardReport(report);

      setPressedKey(keyCode, true); // Record key press
      if (isModifierKey(keyCode)) {
        // Update physical keyboard modifier state
        setVirtualKeyboardModifierState(data => ({
          ...data,
          [keyCode]: true,
        }));
      }

      if (event.code === 'Space' && !isPasteTextOpen) {
        remoteScreenRef?.current?.videoElement?.play();
        // send({ method: 'keyboardReport', params: report })
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const path = event.composedPath();
      for (const el of path) {
        if (!(el instanceof HTMLElement)) continue;

        // Check for editable elements
        const tag = el.tagName?.toLowerCase();
        if (
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          el.isContentEditable ||
          el.getAttribute('role') === 'textbox'
        ) {
          return;
        }

        // Check if element has data-kvm-ignore attribute
        if (el.getAttribute('data-kvm-ignore') === 'true') {
          return;
        }

        // Check for common UI components
        const role = el.getAttribute('role');
        if (role === 'dialog' || role === 'alertdialog') return;
        if (
          el.hasAttribute('data-radix-dialog-overlay') ||
          el.hasAttribute('data-radix-popover-content') ||
          el.hasAttribute('data-radix-dropdown-menu-content') ||
          el.hasAttribute('data-slot') ||
          el.hasAttribute('data-panel') ||
          el.hasAttribute('data-sidebar') ||
          el.hasAttribute('data-sheet')
        ) {
          return;
        }
      }

      const resolvedCode = event.code || resolveModifierCode(event);
      const keyCode = resolvedCode === 'AltRight' ? 'AltGr' : resolvedCode;
      let modifier = 0;

      // Debounce: prevent multiple release events for the same key
      const releaseCount = pressCountRef.current.get(keyCode) || 0;
      if (releaseCount > 2) {
        return;
      }
      pressCountRef.current.set(keyCode, releaseCount + 1);

      // Update local UI state
      setPressedKey(keyCode, false);

      if (isModifierKey(keyCode)) {
        // Update physical keyboard modifier state
        setVirtualKeyboardModifierState(evn => ({
          ...evn,
          [keyCode]: false,
        }));
      } else {
        modifier = externalModifierMask(virtualKeyboardModifierState);
      }
      if (modifierReleaseMode === 'auto') {
        setVirtualKeyboardModifierState(s => {
          const hasPhysicalModifier = Object.values(virtualKeyboardModifierState).some(
            value => value === true
          );
          if (!hasPhysicalModifier) return createInitialModifierState();
          return s;
        });
      }
      setKeysDownState({
        keys: [],
        modifier,
      });

      sendKeyboardReport({
        keys: [0, 0, 0, 0, 0, 0],
        modifier,
      });
    };

    // Clear all pressed keys (called on blur/visibility change)
    const clearAllPressedKeys = () => {
      // Clear local pressed keys state
      resetPressedKeys();

      setVirtualKeyboardModifierState(createInitialModifierState());

      // Send release report to remote
      setKeysDownState({
        keys: [],
        modifier: 0,
      });

      sendKeyboardReport({
        keys: [0, 0, 0, 0, 0, 0],
        modifier: 0,
      });
    };

    // Handle window blur (user switches to another app/window)
    const handleWindowBlur = () => {
      clearAllPressedKeys();
    };

    // Handle visibility change (user switches browser tab)
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearAllPressedKeys();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    // Listen at capture phase to ensure interception
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);

    // Listen for window blur and visibility change to clear stuck keys
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    visibleVirtualKeyboard,
    virtualKeyboardModifierState,
    modifierReleaseMode,
    isTerminalVisible,
    send,
    pressedUsagesRef,
    pressedModsRef,
    isPasteTextOpen,
  ]);

  useEffect(() => {
    const keyboardApi = (
      navigator as Navigator & {
        keyboard?: {
          lock?: (keyCodes?: string[]) => Promise<void>;
          unlock?: () => void;
        };
      }
    ).keyboard;

    if (!keyboardApi) return;

    if (!isFullScreen) {
      keyboardApi.unlock?.();
      return;
    }

    void keyboardApi
      .lock?.([
        'Escape',
        'Tab',
        'AltLeft',
        'AltRight',
        'ControlLeft',
        'ControlRight',
        'ShiftLeft',
        'ShiftRight',
        'MetaLeft',
        'MetaRight',
        'F1',
        'F2',
        'F3',
        'F4',
        'F5',
        'F6',
        'F7',
        'F8',
        'F9',
        'F10',
        'F11',
        'F12',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Backspace',
        'Delete',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Insert',
      ])
      .catch(() => {
        // Keyboard Lock may be unavailable depending on browser/security context.
      });

    return () => {
      keyboardApi.unlock?.();
    };
  }, [isFullScreen]);

  // Long press ESC to exit fullscreen
  useLongPressEscape({
    onLongPress: exitFullscreen,
    delay: 3000, // 3 seconds
    enabled: isFullScreen,
  });

  // Open paste panel from the floating fullscreen button; tries to prefill with clipboard text
  const openFullscreenPaste = useCallback(async () => {
    let initText = '';
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text) initText = text;
    } catch {
      // Clipboard access may be blocked (permissions / focus); ignore
    }
    setFsPasteInitText(initText);
    setFsPasteOpen(true);
  }, []);

  // Drag handlers for the floating paste button (pointer events for mouse + touch)
  const _onFsBtnPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    fsBtnDragRef.current = {
      dragging: true,
      moved: false,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    target.setPointerCapture(e.pointerId);
  }, []);

  const _onFsBtnPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = fsBtnDragRef.current;
      if (!drag.dragging) return;
      const target = e.currentTarget;
      const parent = target.offsetParent as HTMLElement | null;
      const parentRect = parent?.getBoundingClientRect();
      const baseX = parentRect?.left ?? 0;
      const baseY = parentRect?.top ?? 0;
      const nextX = e.clientX - baseX - drag.offsetX;
      const nextY = e.clientY - baseY - drag.offsetY;
      const maxX = (parent?.clientWidth ?? window.innerWidth) - target.offsetWidth;
      const maxY = (parent?.clientHeight ?? window.innerHeight) - target.offsetHeight;
      const clampedX = Math.max(0, Math.min(nextX, maxX));
      const clampedY = Math.max(0, Math.min(nextY, maxY));
      drag.moved = drag.moved || Math.hypot(nextX - fsBtnPos.x, nextY - fsBtnPos.y) > 3;
      setFsBtnPos({ x: clampedX, y: clampedY });
    },
    [fsBtnPos.x, fsBtnPos.y]
  );

  const _onFsBtnPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = fsBtnDragRef.current;
      const wasMoved = drag.moved;
      drag.dragging = false;
      drag.moved = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
      // Treat as a click only when not dragged
      if (!wasMoved) {
        void openFullscreenPaste();
      }
    },
    [openFullscreenPaste]
  );

  // Drag handlers for the floating paste panel (drag by its header handle)
  const _onFsPanelPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement as HTMLElement | null;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    fsPanelDragRef.current = {
      dragging: true,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const _onFsPanelPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fsPanelDragRef.current;
    if (!drag.dragging) return;
    const panel = e.currentTarget.parentElement as HTMLElement | null;
    if (!panel) return;
    const parent = panel.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    const baseX = parentRect?.left ?? 0;
    const baseY = parentRect?.top ?? 0;
    const nextX = e.clientX - baseX - drag.offsetX;
    const nextY = e.clientY - baseY - drag.offsetY;
    const maxX = (parent?.clientWidth ?? window.innerWidth) - panel.offsetWidth;
    const maxY = (parent?.clientHeight ?? window.innerHeight) - panel.offsetHeight;
    const clampedX = Math.max(0, Math.min(nextX, maxX));
    const clampedY = Math.max(0, Math.min(nextY, maxY));
    setFsPanelPos({ x: clampedX, y: clampedY });
  }, []);

  const _onFsPanelPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    fsPanelDragRef.current.dragging = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  // Handle virtual keyboard key press
  const handleVirtualKeyDown = useCallback(
    (data: { keyCode: string; label: string; hidReport: { keys: number[]; modifier: number } }) => {
      sendKeyboardReport(data.hidReport);
    },
    []
  );

  // Handle virtual keyboard key release
  const handleVirtualKeyUp = useCallback(
    (data: { keyCode: string; label: string; hidReport: { keys: number[]; modifier: number } }) => {
      sendKeyboardReport(data.hidReport);
      setPressedKey(data.keyCode, false);
      if (modifierReleaseMode === 'auto') {
        // In auto mode, release all modifiers when a normal key is released
        setVirtualKeyboardModifierState(s => {
          const hasActiveModifier = Object.values(s).some(value => value === true);
          if (hasActiveModifier) {
            return createInitialModifierState();
          }
          return s;
        });
      }
    },
    [modifierReleaseMode]
  );

  // Handle modifier key state changes (Shift, Ctrl, Alt, etc.)
  // This callback is used only for virtual-keyboard modifier clicks
  const handleModifierKeyChange = useCallback((keyCode: string, isActive: boolean) => {
    if (!isActive) {
      //sendKeyboardReport
      sendKeyboardReport({
        keys: [0, 0, 0, 0, 0, 0],
        modifier: (HID_MODIFIERS as Record<string, number>)[keyCode] || 0,
      });
      sendKeyboardReport({
        keys: [0, 0, 0, 0, 0, 0],
        modifier: 0,
      });
    }
    setVirtualKeyboardModifierState(prev => ({
      ...prev,
      [keyCode]: isActive,
    }));
  }, []);

  // Hide virtual keyboard
  const handleHideKeyboard = useCallback(() => {
    toggleMain('virtualKeyboard');
  }, []);

  // Handle keyboard layout change
  const handleLanguageChange = useCallback((layout: string) => {
    setKeyboardLanguage(layout);
  }, []);

  // Memoize VirtualKeyboard props to prevent unnecessary re-renders
  const keyboardStyle = useMemo(() => ({ height: `${keyboardHeight}px` }), [keyboardHeight]);

  const keyboardLeftSlotDocked = useMemo(
    () => (
      <Button size="sm" onClick={() => setKeyboardDisplayMode('floating')}>
        Float
      </Button>
    ),
    []
  );

  const keyboardLeftSlotFloating = useMemo(
    () => (
      <Button size="sm" onClick={() => setKeyboardDisplayMode('docked')}>
        Docked
      </Button>
    ),
    []
  );

  // OCR text recognition complete callback
  const handleTextRecognized = useCallback((_text: string) => {
    // Keep OCR mode open so users can review/copy text manually when clipboard is restricted.
  }, []);

  // OCR button click handler - toggle OCR mode
  const handleOcrClick = useCallback(() => {
    setOcrEnabled(prev => !prev);
  }, []);

  // OCR cancel handler - close OCR mode
  const handleOcrCancel = useCallback(() => {
    setOcrEnabled(false);
  }, []);

  // Store latest state in ref to avoid callback recreation
  const stateRef = useRef({
    isChannelReady,
    peerState,
    usbState,
    hdmiConnectionState,
  });
  useEffect(() => {
    stateRef.current = {
      isChannelReady,
      peerState,
      usbState,
      hdmiConnectionState,
    };
  }, [isChannelReady, peerState, usbState, hdmiConnectionState]);

  // Mouse events (disabled in OCR mode to avoid conflicts)
  // Note: Allow HID events even when HDMI has no signal (hdmiConnectionState !== 'ready')
  // so that mouse movement can wake the target device from sleep.
  // Also allow events when USB is suspended (S3 state) to enable wake-from-sleep.
  // Note: In S3 state, WebSocket may disconnect but RTC peer connection remains, so we only check peerState.
  const handleAbsMove = useCallback(
    (x: number, y: number, buttons: number) => {
      const { peerState, usbState } = stateRef.current;
      if (peerState !== 'connected' || (usbState !== 'configured' && usbState !== 'suspended')) {
        return;
      }
      sendAbsMouseReport({ x, y, buttons });
    },
    [sendAbsMouseReport]
  );

  const handleRelMove = useCallback(
    ({
      dx,
      dy,
      buttons,
      y,
      x,
    }: {
      dx: number;
      dy: number;
      buttons: number;
      x: number;
      y: number;
    }) => {
      const { peerState, usbState } = stateRef.current;
      if (peerState !== 'connected' || (usbState !== 'configured' && usbState !== 'suspended'))
        return;

      const sdx = Number.isFinite(dx) ? Math.round(dx) : 0;
      const sdy = Number.isFinite(dy) ? Math.round(dy) : 0;
      setMouseMove({ x, y, buttons });
      sendRelMouseReport({ dx: sdx, dy: sdy, buttons });
    },
    [setMouseMove, sendRelMouseReport]
  );

  const handleWheel = useCallback(
    (data: { deltaX: number; deltaY: number; wheelX: number; wheelY: number }) => {
      const { peerState, usbState } = stateRef.current;

      if (peerState !== 'connected' || (usbState !== 'configured' && usbState !== 'suspended'))
        return;
      const { wheelX, wheelY } = data;
      sendWheelReport({ wheelX, wheelY });
    },
    [sendWheelReport]
  );

  const handleDoubleClick = useCallback(
    async (_button: number, x: number, y: number, source: 'mouse' | 'touch') => {
      // Touch double-tap (touch source) does not trigger synthetic mouse double-click: native tap semantics differ from mouse double-click
      if (source === 'mouse') return;

      const { peerState, usbState, hdmiConnectionState } = stateRef.current;
      if (
        peerState !== 'connected' ||
        (usbState !== 'configured' && usbState !== 'suspended') ||
        hdmiConnectionState !== 'ready'
      )
        return;

      // Helper to create tracked timeout
      const createTrackedTimeout = (fn: () => void, delay: number) => {
        const timer = setTimeout(() => {
          doubleClickTimersRef.current.delete(timer);
          fn();
        }, delay);
        doubleClickTimersRef.current.add(timer);
        return timer;
      };
      const waitForNextReport = (delay: number) =>
        new Promise<void>(resolve => {
          createTrackedTimeout(resolve, delay);
        });

      try {
        const fallbackPos =
          typeof x === 'number' && typeof y === 'number' ? { x, y } : { x: 16383, y: 16383 };
        const currentPos = fallbackPos;

        // First click
        sendAbsMouseReport({ x: currentPos.x, y: currentPos.y, buttons: 1 });
        await waitForNextReport(50);
        sendAbsMouseReport({ x: currentPos.x, y: currentPos.y, buttons: 0 });
        await waitForNextReport(50);
        sendAbsMouseReport({ x: currentPos.x, y: currentPos.y, buttons: 1 });
        await waitForNextReport(50);
        sendAbsMouseReport({
          x: currentPos.x,
          y: currentPos.y,
          buttons: 0,
        });
      } catch (error) {
        logger.error('Double click error:', error);
      }
    },
    [sendAbsMouseReport]
  );

  const mouseEventsEnabled = (isChannelReady || peerState === 'connected') && !ocrEnabled;
  useMouseEvents({
    videoRef: mouseVideoRef,
    videoWidth,
    videoHeight,
    enabled: mouseEventsEnabled,
    mode: mouseInputMode,
    scrollThrottling,
    invertScroll: false,
    jiggler,
    onAbsMove: handleAbsMove,
    onRelMove: handleRelMove,
    onWheel: handleWheel,
    onDoubleClick: handleDoubleClick,
    hdmiConnectionState,
  });

  return (
    <div
      ref={appContainerRef}
      data-arkkvm-app="true"
      className={cn(
        'text-text h-screen flex flex-col overflow-hidden',
        isFullScreen && 'fullscreen-mode'
      )}
    >
      <FullscreenPortalProvider container={portalContainer}>
        <ConfirmDialogProvider>
          {/* Top Navigation Bar - USB & Device Connection Status - Hidden in fullscreen via CSS */}
          <div className={cn('fullscreen-hidden', isFullScreen && 'hidden')}>
            <TopNavbar
              brandLogoType="icon"
              links={[
                {
                  title: 'Cloud Devices',
                  href: '/devices/list',
                  Icon: IconCloud,
                },
              ]}
              deviceName={deviceName || 'ArkKVM Device'}
              hostname={(hostname as string) || ''}
              usbState={usbState}
              peerState={peerState}
              showLoggedIn={env.target === 'cloud' || authMode === 'password'}
              showDeviceStatus={true}
              onFullScreenClick={onFullScreenClick}
              onReconnect={(countdown?: number) => {
                if (typeof countdown === 'number') {
                  // Start restart process and display countdown
                  setIsRestarting(true);
                  setRestartCountdown(countdown);
                  window.setTimeout(() => {
                    remoteScreenRef.current?.disconnect?.();
                    resetRTC();
                    setAllowWebSocketConnection(false);
                  }, 300);
                } else {
                  // Reconnect immediately
                  void reconnectWithGuardRef.current({
                    delayMs: 200,
                    onAfterEnable: () => setIsRestarting(false),
                  });
                }
              }}
            ></TopNavbar>
          </div>

          {/* Control Toolbar - Horizontal Layout - Hidden in fullscreen via CSS */}
          <AnimatePresence initial={false}>
            {controlLayoutMode === 'horizontal' && (
              <motion.div
                key="top-controls"
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className={cn('fullscreen-hidden', isFullScreen && 'hidden')}
              >
                <ControlToolbar
                  onKeyboardLayoutClick={() => setKeyboardEnabled(!keyboardEnabled)}
                  keyboardEnabled={false}
                  inputEventsEnabled={true}
                  terminalEnabled={terminalEnabled}
                  onOcrClick={handleOcrClick}
                  ocrEnabled={ocrEnabled}
                  rpc={rpc}
                  closeAllPopoversRef={closeToolbarPopoversRef}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Content Area */}
          <motion.div
            className="grow overflow-hidden relative"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            {/* Loading State Overlay */}
            <DefaultLoadingOverlay
              loading={isLoading}
              text={t('rtc.peer.connecting')}
              className="absolute inset-0 z-10 pointer-events-none"
              blur={false}
              layout="col"
            />
            <div className="flex h-full w-full min-h-0 items-stretch flex-row">
              <AnimatePresence initial={false}>
                {controlLayoutMode === 'vertical' && (
                  <motion.div
                    key="left-sidebar"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className={cn('fullscreen-hidden', isFullScreen && 'hidden')}
                  >
                    <ControlSidebar
                      rpc={rpc}
                      className="shrink-0"
                      activeKey={activeSidebarPanel}
                      ocrEnabled={ocrEnabled}
                      onOcrClick={handleOcrClick}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
              {controlLayoutMode === 'vertical' && !isFullScreen && (
                <>
                  {/* {
                isFullScreen&& <FullscreenFloatingToolbar

                rpc={rpc}
                  className="shrink-0"
                  activeKey={activeSidebarPanel}
                  ocrEnabled={ocrEnabled}
                  onOcrClick={handleOcrClick}
              />
              } */}
                  <SlidePanel
                    open={true}
                    side="left"
                    width={visibleConnectionStats ? 'min(450px, calc(100vw - 48px))' : 0}
                    duration={300}
                    position="inline"
                    contentClassName="h-full shrink-0 min-w-0"
                  >
                    {visibleConnectionStats && (
                      <StreamAnalytics
                        rpc={rpc}
                        peerConnection={peerConnection}
                        peerState={peerState}
                        closeIcon={<IconToLeft />}
                      />
                    )}
                  </SlidePanel>
                  <SlidePanel
                    open={true}
                    side="left"
                    width={visibleSettings ? 'min(700px,  calc(100vw - 40px))' : 0}
                    duration={300}
                    position="inline"
                    contentClassName="h-full shrink-0"
                  >
                    {visibleSettings && (
                      <Settings
                        className="h-full w-full"
                        rpc={rpc}
                        closeIcon={<IconToLeft />}
                        onNetworkReconnect={reconnectWithGuard}
                      />
                    )}
                  </SlidePanel>
                </>
              )}

              {/* Restart overlay - keep outside conditional blocks to ensure it can always render */}
              {isRestarting && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80">
                  <div className="flex flex-col items-center gap-4 text-center p-8">
                    <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <h2 className="text-xl font-semibold text-text">
                      {t('restart.title', {
                        defaultValue: 'Device Restarting',
                      })}
                    </h2>
                    <p className="text-gray-300">
                      {t('restart.desc', {
                        defaultValue: 'Reconnecting in {{seconds}} seconds...',
                        seconds: restartCountdown,
                      })}
                    </p>
                    <button
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-text rounded-md transition-colors"
                      onClick={() => {
                        void reconnectWithGuard({
                          delayMs: 200,
                          onAfterEnable: () => setIsRestarting(false),
                        });
                      }}
                    >
                      {t('reconnect', { defaultValue: 'Reconnect Now' })}
                    </button>
                  </div>
                </div>
              )}
              {/* xddd    isFullScreen ? 'fixed inset-0 z-[9998] h-screen w-screen' : 'h-full'*/}
              {serverUrl && allowWebSocketConnection && iceServers ? (
                <div
                  className={cn('flex-1 min-w-0 relative overflow-hidden bg-(--bg-primary) h-full')}
                >
                  {/* Fullscreen Floating Toolbar - Only shown in fullscreen mode */}

                  {/* Stable video container - structure never changes to prevent remount */}
                  <div
                    className="w-full overflow-hidden transition-[height] duration-300 ease-in-out"
                    style={{
                      height: `calc(100% - ${
                        (keyboardDisplayMode === 'docked' && visibleVirtualKeyboard
                          ? keyboardHeight
                          : 0) + (visibleTerminal && !terminalOverlay ? 344 : 0)
                      }px)`,
                    }}
                  >
                    <AspectRatioContainer
                      className={cn(
                        'w-full overflow-hidden transition-all duration-300 ease-in-out',
                        isFullScreen ? 'h-full w-full' : 'h-(--dynamic-height)'
                      )}
                      fillParent={false}
                    >
                      <RemoteScreen
                        className="w-full flex items-center justify-center"
                        ref={remoteScreenRef}
                        isCursorHidden={hideCursor}
                        cursorStyle={cursorStyle}
                        serverUrl={serverUrl}
                        hdmiState={hdmiConnectionState}
                        ocrEnabled={ocrEnabled}
                        onTextRecognized={handleTextRecognized}
                        onOcrCancel={handleOcrCancel}
                        mouseInputMode={mouseInputMode}
                        enhancement={enhancement}
                        rtcConfig={rtcConfigMemo}
                        captureAudio={true}
                        onPeerConnection={pc => {
                          clearUploads();
                          terminalChannelRef.current = null;
                          setTerminalMountKey(key => key + 1);
                          setTerminalChannel(null);
                          setRpcDataChannel(null);
                          setSerialChannel(null);
                          setDiskChannel(null);
                          setRtcField('inputChannel', null);
                          setRtcField('inputUnstableChannel', null);
                          setRtcField('peerConnection', pc);
                        }}
                        onDataChannels={channels => {
                          if (terminalChannelRef.current !== channels.terminal) {
                            terminalChannelRef.current = channels.terminal;
                            setTerminalMountKey(key => key + 1);
                          }
                          setTerminalChannel(channels.terminal);
                          setRpcDataChannel(channels.rpc);
                          setSerialChannel(channels.serial);
                          setDiskChannel(channels.disk);
                          setRtcField('inputChannel', channels.input);
                          setRtcField('inputUnstableChannel', channels.inputUnstable);
                        }}
                        onPeerConnectionStateChange={state => {
                          setRtcField('peerConnectionState', state);
                          if (['disconnected', 'failed', 'closed'].includes(state)) {
                            resetHID();
                            // Dismiss update dialog upon device disconnection
                            resetOtaState();
                            closeOtaDialog();
                          } else if (state === 'connected') {
                            getVideoStateAsyn();
                          }
                        }}
                        onVideoSizeChange={size => {
                          const { width, height } = size;
                          setContainerSize(width, height);
                        }}
                      />
                    </AspectRatioContainer>
                  </div>

                  {/* Bottom panels - absolutely positioned, stacked from bottom */}
                  <div
                    className={cn(
                      'absolute bottom-0 left-0 right-0 transition-[height] duration-300 ease-in-out',
                      !isFullScreen && 'overflow-hidden'
                    )}
                    style={
                      {
                        '--keyboard-height': `${
                          (keyboardDisplayMode === 'docked' && visibleVirtualKeyboard
                            ? keyboardHeight
                            : 0) + (visibleTerminal && !terminalOverlay ? 344 : 0)
                        }px`,
                      } as React.CSSProperties
                    }
                  >
                    <div className="h-(--keyboard-height)" />
                    {/* Docked Virtual Keyboard */}
                    {visibleVirtualKeyboard && keyboardDisplayMode === 'docked' && (
                      <VirtualKeyboard
                        className="shrink-0 bg-(--bg-secondary)"
                        style={keyboardStyle}
                        onKeyDown={handleVirtualKeyDown}
                        onKeyUp={handleVirtualKeyUp}
                        onModifierKeyChange={handleModifierKeyChange}
                        onHide={handleHideKeyboard}
                        onLanguageChange={handleLanguageChange}
                        simulateEvents={false}
                        leftSlot={keyboardLeftSlotDocked}
                        defaultLanguage={keyboardLanguage}
                        locale={currentLang}
                        {...virtualKeyboardModifierState}
                        CapsLock={keyboardLedState?.caps_lock}
                        modifierReleaseMode={modifierReleaseMode}
                      />
                    )}

                    {/* Terminal - always mounted in the same position.
                    When isOverlay=true the component itself switches to
                    position:fixed covering the viewport, so there is no
                    remount and xterm scrollback is preserved across toggles.
                    Content only clears on Hide. */}
                    {visibleTerminal && remoteScreenRef.current && (
                      <XtermTerminal
                        key={terminalMountKey}
                        title="Web Terminal"
                        dataChannel={terminalChannel}
                        type="terminal"
                        isOverlay={terminalOverlay}
                        onToggleOverlay={() => setTerminalOverlay(prev => !prev)}
                        onReconnectRequest={() => {
                          remoteScreenRef.current?.reconnect?.(true);
                        }}
                        rpc={rpc}
                      />
                    )}
                  </div>

                  {/* Floating Virtual Keyboard */}
                  {keyboardDisplayMode === 'floating' && visibleVirtualKeyboard && (
                    <DraggablePanel
                      title=""
                      isOpen={true}
                      onClose={() => setKeyboardDisplayMode('docked')}
                      defaultPosition={{ x: 100, y: 100 }}
                      showHeader={false}
                      width="auto"
                    >
                      <VirtualKeyboard
                        className="w-[1000px] pb-[0] bg-(--bg-secondary)"
                        draggable={true}
                        onKeyDown={handleVirtualKeyDown}
                        onKeyUp={handleVirtualKeyUp}
                        onModifierKeyChange={handleModifierKeyChange}
                        onHide={handleHideKeyboard}
                        onLanguageChange={handleLanguageChange}
                        simulateEvents={false}
                        leftSlot={keyboardLeftSlotFloating}
                        defaultLanguage={keyboardLanguage}
                        locale={currentLang}
                        {...virtualKeyboardModifierState}
                        CapsLock={keyboardLedState?.caps_lock}
                        modifierReleaseMode={modifierReleaseMode}
                      />
                    </DraggablePanel>
                  )}

                  {/* Fullscreen-only: draggable paste button + on-demand paste panel */}
                  {/* {isFullScreen && !fsPasteOpen && (
                <button
                  type="button"
                  aria-label={t('toolbar.pasteText')}
                  title={t('toolbar.pasteText')}
                  onPointerDown={onFsBtnPointerDown}
                  onPointerMove={onFsBtnPointerMove}
                  onPointerUp={onFsBtnPointerUp}
                  onPointerCancel={onFsBtnPointerUp}
                  className="fixed z-[9999] flex h-[32px] w-[32px] cursor-pointer items-center justify-center rounded-[6px] bg-(--bg-primary) text-(--text-primary) opacity-80 hover:opacity-100"
                  style={{
                    '--fs-btn-left': `${fsBtnPos.x}px`,
                    '--fs-btn-top': `${fsBtnPos.y}px`,
                    left: 'var(--fs-btn-left)',
                    top: 'var(--fs-btn-top)',
                  } as React.CSSProperties}
                >
                  <IconClipboard className="size-[18px]" />
                </button>
              )} */}

                  {/* {isFullScreen && fsPasteOpen && (
                <div
                  className="absolute z-[10000] w-[420px] max-w-[90vw] rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl"
                  style={{
                    '--fs-panel-left': `${
                      fsPanelPos?.x ??
                      Math.min(
                        Math.max(20, window.innerWidth - 440),
                        Math.max(20, fsBtnPos.x - 194)
                      )
                    }px`,
                    '--fs-panel-top': `${
                      fsPanelPos?.y ??
                      Math.min(
                        Math.max(60, window.innerHeight - 200),
                        fsBtnPos.y + 40
                      )
                    }px`,
                    left: 'var(--fs-panel-left)',
                    top: 'var(--fs-panel-top)',
                  } as React.CSSProperties}
                >
                  <div
                    onPointerDown={onFsPanelPointerDown}
                    onPointerMove={onFsPanelPointerMove}
                    onPointerUp={onFsPanelPointerUp}
                    onPointerCancel={onFsPanelPointerUp}
                    className="flex h-[24px] cursor-grab items-center justify-center rounded-t-[8px] bg-[var(--bg-tertiary,rgba(255,255,255,0.05))] active:cursor-grabbing touch-none"
                    title="Drag to move"
                  >
                    <div className="h-[3px] w-[32px] rounded-full bg-[var(--text-secondary)] opacity-40" />
                  </div>
                  <button
                    type="button"
                    aria-label="Close"
                    className="absolute top-[2px] right-[10px] text-[18px] leading-none text-[var(--text-secondary)] hover:text-[var(--text-color)]"
                    onClick={() => setFsPasteOpen(false)}
                  >
                    ×
                  </button>
                  <div className="p-[16px] pt-[12px]">
                    <PasteText
                      key={fsPasteInitText}
                      initialText={fsPasteInitText}
                      onSend={() => setFsPasteOpen(false)}
                    />
                  </div>
                </div>
              )} */}
                </div>
              ) : (
                <div className="flex-1 w-full h-full flex items-center justify-center">
                  <ConnectionIssuePanel
                    title={t('messages:connectionTimeout.title')}
                    subtitle={t('messages:connectionTimeout.subtitle')}
                    items={t('messages:connectionTimeout.items', {
                      returnObjects: true,
                    })}
                  />
                </div>
              )}

              <SlidePanel
                open={true}
                side="right"
                width={visibleExtension ? 400 : 0}
                duration={300}
                position="inline"
                contentClassName="h-full shrink-0"
              >
                <Extension rpc={rpc} />
              </SlidePanel>
              {}

              {controlLayoutMode !== 'vertical' && (
                <>
                  <SlidePanel
                    open={true}
                    side="right"
                    width={visibleConnectionStats ? 'min(450px, 100vw)' : 0}
                    duration={300}
                    position="inline"
                    contentClassName="h-full shrink-0 min-w-0"
                  >
                    {visibleConnectionStats && (
                      <StreamAnalytics
                        rpc={rpc}
                        peerConnection={peerConnection}
                        peerState={peerState}
                      />
                    )}
                  </SlidePanel>
                  <SlidePanel
                    open={true}
                    side="right"
                    width={visibleSettings ? 'min(700px, 100vw)' : 0}
                    duration={300}
                    position="inline"
                    contentClassName="h-full shrink-0"
                  >
                    {visibleSettings && (
                      <Settings
                        className="h-full w-full"
                        rpc={rpc}
                        onNetworkReconnect={reconnectWithGuard}
                      />
                    )}
                  </SlidePanel>
                </>
              )}
            </div>
          </motion.div>
          {showStatusBar && !isFullScreen && (
            <SessionStatusBar videoRef={mouseVideoRef} peerState={peerState} />
          )}

          <ControlLeaseDialog
            prompt={showSessionConflictDialog ? null : controlLease.prompt}
            busy={controlLease.busy}
            error={controlLease.error}
            onAction={action => {
              void controlLease.act(action, sendAsync);
            }}
            onViewOnly={() => {
              if (controlLease.prompt?.kind === 'request' && controlLease.error !== 'stale') {
                void controlLease.act('grantControl', sendAsync);
              } else {
                controlLease.reset();
              }
            }}
          />
          {/* Session Conflict Dialog */}
          <Dialog
            open={showSessionConflictDialog}
            onOpenChange={setShowSessionConflictDialog}
            title={t('session.active.title')}
            description={t('session.active.desc')}
            confirmText={t('session.active.use_here')}
            showCancel={false}
            preventOutsideClose
            width="600px"
            contentClassName="z-[9999] pb-0"
            onConfirm={() => {
              // The user's explicit consent is the only thing that re-arms reconnection.
              sessionPreemptedRef.current = false;
              setShowSessionConflictDialog(false);
              void reconnectWithGuard();
            }}
          />
          {/*  */}
          <SystemUpdateDialog />
          {/* Post-update reconnection overlay */}
          <ReconnectOverlay />
          {!showSessionConflictDialog && isChannelReady && <VlanPendingConfirmDialog />}
        </ConfirmDialogProvider>
      </FullscreenPortalProvider>
    </div>
  );
};

export default KVMControlPage;
