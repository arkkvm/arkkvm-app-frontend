import { env } from '@/utils';
import { createLogger } from '@/utils/logger';
import {
  OutboundIceGate,
  beginNegotiation,
  buildSignalingOutbound,
  clearWebRTCSessionId,
  createUserSignalingIdentity,
  parseMintedClientId,
  parseSessionId,
  type SignalingIdentity,
} from '@/utils/webrtcSignalingIdentity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useWebSocket from 'react-use-websocket';

const logger = createLogger('useDesktopRtc');

function _byteLenOfString(str: string) {
  return new TextEncoder().encode(str).length; // UTF-8 byte count
}
// WebSocket connection state
export type WebSocketConnectionState =
  | 'connecting' // WebSocket is connecting
  | 'connected' // WebSocket connection established
  | 'disconnected' // WebSocket disconnected normally
  | 'error' // WebSocket connection error
  | 'reconnecting' // WebSocket is reconnecting
  | 'closed'; // WebSocket closed

// WebRTC connection state
export type WebRTCConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';
export type ViewerStatus =
  | 'initializing'
  | 'ws_connecting'
  | 'negotiating'
  | 'ice_gathering'
  | 'waiting_connection'
  | 'ice_checking'
  | 'waiting_media'
  | 'media_loading'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export const ViewerStatusMessage: Record<ViewerStatus, string> = {
  initializing: 'Initializing session...',
  ws_connecting: 'Connecting to device...',
  negotiating: 'Establishing remote session...',
  ice_gathering: 'Gathering network candidates...',
  waiting_connection: 'ICE candidate gathering completed, waiting for connection...',
  ice_checking: 'Checking network path...',
  waiting_media: 'Connection established, waiting for media...',
  media_loading: 'Media stream received, loading video...',
  connected: 'Connected',
  reconnecting: 'Connection interrupted, retrying...',
  failed: 'Connection failed',
  closed: 'Connection closed',
};
export const PeerConnectionStateMessage: Record<WebRTCConnectionState, string> = {
  new: 'Initializing peer connection...',
  connecting: 'Establishing peer connection...',
  connected: 'Peer connection established, waiting for media...',
  disconnected: 'Peer connection lost, preparing to reconnect...',
  failed: 'Peer connection failed, preparing to reconnect...',
  closed: 'Peer connection closed',
};
export const IceConnectionStateMessage: Record<WebRTCConnectionState, string> = {
  new: 'Initializing ICE connection...',
  checking: 'Establishing ICE connection...',
  connected: 'ICE connection established, waiting for media...',
  completed: 'ICE connection completed',
  disconnected: 'ICE connection lost, preparing to reconnect...',
  failed: 'ICE connection failed, preparing to reconnect...',
  closed: 'ICE connection closed',
};
export const NegotiationStatusMessage = {
  creatingLocalOffer: 'Creating local SDP offer...',
  waitingRemoteAnswer: 'Local SDP sent, waiting for remote answer...',
} as const;

// Log prefix for console filtering
const LOG_PREFIX = '[WebRTC]';
const _getLogTime = () => {
  const now = new Date();
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `${now.toTimeString().split(' ')[0]}.${ms}`;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const log = (...args: any[]) => addLog(`${LOG_PREFIX} ${args.join(' ')}`, 'info');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logError = (...args: any[]) => addLog(`${LOG_PREFIX} ${args.join(' ')}`, 'error');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logWarn = (...args: any[]) => addLog(`${LOG_PREFIX} ${args.join(' ')}`, 'warning');

export const ConnectionStatusText = {
  remoteAnswerApplied: 'Remote answer applied, waiting for media streams...',
  wsWaitingDeviceInfo: 'WebSocket connected, waiting for device information...',
  wsDisconnected: 'WebSocket disconnected',
  wsError: 'WebSocket connection error',
  deviceInfoReceived: 'Device information received, preparing WebRTC connection...',
  creatingPeerConnection: 'Creating peer connection...',
  iceGatheringComplete: 'ICE candidate gathering completed, waiting for connection...',
  iceGathering: 'Gathering ICE candidates...',
  mediaTrackReceived: 'Media track received, waiting for video to start...',
  idle: '',
} as const;

// Combined connection state
export type ConnectionState = {
  ws: WebSocketConnectionState;
  webrtc: WebRTCConnectionState;
};

// Export data channel types for upper layer declaration
export interface DataChannels {
  rpc: RTCDataChannel;
  terminal: RTCDataChannel;
  serial: RTCDataChannel;
  disk: RTCDataChannel;
  input: RTCDataChannel;
  inputUnstable: RTCDataChannel;
}

// Log entry structure
export interface LogEntry {
  message: string;
  timestamp: number;
  type: 'info' | 'error' | 'warning' | 'success';
}

// Hook configuration options
export interface UseDesktopRtcOptions {
  // WebSocket address
  serverUrl: string;

  // Connection role: user (human console) or agent (automation)
  clientType?: 'user' | 'agent';

  // WebSocket request headers
  headers?: Record<string, string>;

  // Auto connect on component mount
  autoConnect?: boolean;

  // Auto reconnect on disconnect
  shouldReconnect?: boolean;

  // Max reconnect attempts (0 for infinite)
  reconnectAttempts?: number;

  // Reconnect interval (milliseconds)
  reconnectInterval?: number;

  // Reconnect interval exponential backoff factor
  reconnectBackoffFactor?: number;

  // Max reconnect interval (milliseconds)
  maxReconnectDelay?: number;

  // Additional STUN/TURN servers
  iceServers?: RTCIceServer[];

  // Max log entries to keep
  maxLogEntries?: number;

  // Whether to output logs to console
  shareToConsole?: boolean;

  // WebRTC configuration
  rtcConfig?: RTCConfiguration;

  // Whether to capture audio
  captureAudio?: boolean;
  onMessage?: (data: unknown) => void;
  // Callback when RTCPeerConnection is created
  onPeerConnection?: (pc: RTCPeerConnection) => void;
  // Callback when data channels are created
  onDataChannels?: (channels: DataChannels) => void;
  // Callback when RTCPeerConnectionState changes
  onPeerConnectionStateChange?: (state: WebRTCConnectionState | RTCPeerConnectionState) => void;

  // Optional: External video element Ref for precise binding (multi-instance scenario)
  videoRef?: React.RefObject<HTMLVideoElement>;

  // Callback notification on connection lost
  onConnectionLost?: (type: 'websocket' | 'webrtc', reason?: string) => void;

  // View-only mode: skip sendonly transceivers and data channels (for preview/monitoring)
  viewOnly?: boolean;

  // Optional: External audio element Ref
  audioRef?: React.RefObject<HTMLAudioElement>;
}

// Hook return type
export interface UseDesktopRtcResult {
  // Current connection state
  connectionState: ConnectionState;
  viewerStatus: ViewerStatus;
  // Ref bound to video element
  videoRef: React.RefObject<HTMLVideoElement>;
  audioRef?: React.RefObject<HTMLAudioElement>;
  // webrtc
  peerConnection: RTCPeerConnection | null;

  // Manual disconnect method
  disconnect: () => void;
  // Manually re-initiate WebRTC connection (when WebSocket is still available)
  reconnect: (force?: boolean) => void;
  // Manually unmute and try to play (to satisfy browser gesture policy)
  unmute: () => void;
  // WebAudio: Set gain (1.0 for original volume)
  boostAudio: (gain: number) => void;
  // WebAudio: Resume audio context after gesture
  resumeAudio: () => Promise<void>;
  connectionStatusMessage: string;
  peerConnectionState: RTCPeerConnectionState;
  // Get current peer id related info (ufrag, pwd, state, etc.)
  getPeerId: () => {
    localUfrag: string | null;
    localPwd: string | null;
    remoteUfrag: string | null;
    remotePwd: string | null;
    state: RTCPeerConnectionState;
    signalingState: RTCSignalingState;
  } | null;
}

// Minimal typings for experimental WebRTC codec-preference APIs not yet in lib.dom.
interface RTCRtpCodecCapability {
  mimeType: string;
}

interface RTCRtpTransceiverWithCodecPrefs {
  setCodecPreferences?(codecs: RTCRtpCodecCapability[]): void;
}

interface RTCRtpReceiverWithCapabilities {
  getCapabilities?(kind: 'audio' | 'video'): { codecs: RTCRtpCodecCapability[] } | null;
}

const LOG_LEVEL_WEIGHT: Record<LogEntry['type'], number> = {
  error: 3,
  warning: 2,
  success: 1,
  info: 1,
};

function getRuntimeLogLevelWeight() {
  if (typeof window === 'undefined') return 2;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (w.__arkkvm_debug__ === true) return 1;

  const level = String(w.__arkkvm_log_level__ || 'warning').toLowerCase();
  if (level === 'error') return 3;
  if (level === 'warning' || level === 'warn') return 2;
  return 1;
}

function addLog(message: string, type: LogEntry['type'] = 'info') {
  if (!import.meta.env.DEV) return;
  if (LOG_LEVEL_WEIGHT[type] < getRuntimeLogLevelWeight()) return;

  const logMethod = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info';
  logger[logMethod](`[WebRTC Audio] ${message}`);
}

export const useDesktopRtc = ({
  serverUrl,
  clientType,
  autoConnect = true,
  shouldReconnect = true,
  reconnectAttempts = 5,
  reconnectInterval = 3000,
  reconnectBackoffFactor = 1.5,
  maxReconnectDelay = 30000,
  iceServers = [], //{ urls: 'stun:stun.l.google.com:19302' }
  maxLogEntries: _maxLogEntries = 100,
  shareToConsole: _shareToConsole = true,
  rtcConfig = {},
  captureAudio = true,

  onMessage: _onMessage,
  onPeerConnection,
  onDataChannels,
  onPeerConnectionStateChange,
  videoRef: externalVideoRef,
  audioRef: externalAudioRef,
  onConnectionLost: _onConnectionLost,
  viewOnly = false,
}: UseDesktopRtcOptions): UseDesktopRtcResult => {
  // Unified stable stream carrying all remote tracks
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  // Save references to current four data channels for state checking or recovery
  const dataChannelsRef = useRef<DataChannels | null>(null);
  // WebAudio pipeline
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const unmutedRef = useRef(false);
  const touchUnlockHandlerRef = useRef<((event: TouchEvent) => void) | null>(null);

  const [peerConnectionState, setPeerConnectionState] = useState<RTCPeerConnectionState>('new');
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const manualCloseRef = useRef<boolean>(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    ws: 'disconnected',
    webrtc: 'new',
  });
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('initializing');

  const signalingUrl = useMemo(() => {
    if (!serverUrl) return serverUrl;
    const url = new URL(serverUrl, window.location.href);
    url.searchParams.set('clientType', clientType ?? 'user');
    return url.toString();
  }, [serverUrl, clientType]);

  const [connectionStatusMessage, setConnectionStatusMessage] = useState<string>(''); // Connection status message (user-facing text handled below)
  const updateViewerStatus = useCallback((status: ViewerStatus, syncMessage: boolean = true) => {
    setViewerStatus(status);
    if (syncMessage) {
      setConnectionStatusMessage(ViewerStatusMessage[status]);
    }
  }, []);
  const isCreatingOffer = useRef(false); // Whether creating offer
  const offerSentTime = useRef<number>(0); // Record offer send time
  const answerTimeoutRef = useRef<number | null>(null); // Answer timeout timer
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]); // inbound ICE before remoteDescription
  const outboundIceGateRef = useRef(new OutboundIceGate()); // cloud: hold local ICE until session_id
  const sendWebRTCSignalRef = useRef<(type: string, data: unknown) => void>(() => {});
  const signalingIdentityRef = useRef<SignalingIdentity>(
    createUserSignalingIdentity(
      env.target === 'cloud' ? 'cloud' : 'lan',
      clientType ?? 'user'
    )
  );
  useEffect(() => {
    signalingIdentityRef.current.clientType = clientType ?? 'user';
  }, [clientType]);
  const videoTransformWorkerRef = useRef<Worker | null>(null); // Video transform worker reference
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const internalAudioRef = useRef<HTMLAudioElement>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;
  const audioRef = externalAudioRef ?? internalAudioRef;

  useEffect(() => {
    if (autoConnect && signalingUrl) {
      updateViewerStatus('ws_connecting');
    }
  }, [autoConnect, signalingUrl, updateViewerStatus]);

  // Create data channels (RPC / terminal / serial / disk)
  const createDataChannels = useCallback(
    (pc: RTCPeerConnection): DataChannels => {
      // Create RPC data channel
      const rpcDataChannel = pc.createDataChannel('rpc', { ordered: true });

      // Create disk data channel
      const diskDataChannel = pc.createDataChannel('disk', { ordered: true });

      // Maintain local channels reference
      const channels: DataChannels = {
        rpc: rpcDataChannel,
        terminal: pc.createDataChannel('terminal', { ordered: true }),
        serial: pc.createDataChannel('serial', { ordered: true }),
        disk: diskDataChannel,
        input: pc.createDataChannel('input', { ordered: true }),
        inputUnstable: pc.createDataChannel('input_unstable', {
          ordered: true,
          maxRetransmits: 0,
        }),
      };
      channels.inputUnstable.binaryType = 'arraybuffer';

      const exposeDataChannels = (reason: string) => {
        addLog(`data channels exposed: ${reason}`, 'info');
        try {
          onDataChannels?.(channels);
        } catch {}
      };

      const bind = (ch: RTCDataChannel, label: keyof DataChannels) => {
        ch.onopen = () => {
          addLog(`${label} channel open`, 'success');
          exposeDataChannels(`${label} open`);
        };

        ch.onclose = () => {
          addLog(`${label} channel closed`, 'warning');
        };

        ch.onerror = e => {
          addLog(
            `${label} channel error: ${
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (e as any)?.message || (e as any)?.toString?.() || 'unknown'
            }`,
            'error'
          );
        };
      };

      bind(channels.rpc, 'rpc');
      bind(channels.terminal, 'terminal');
      bind(channels.serial, 'serial');
      bind(channels.disk, 'disk');
      bind(channels.input, 'input');
      bind(channels.inputUnstable, 'inputUnstable');

      // Save data channel references for later use
      dataChannelsRef.current = channels;
      exposeDataChannels('created');

      return channels;
    },
    [addLog, onDataChannels]
  );

  // WebAudio: Create/connect audio pipeline
  const ensureAudioPipeline = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        const AudioCtx =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          window.AudioContext || (window as any).webkitAudioContext;
        ctx = new AudioCtx();
        audioCtxRef.current = ctx;
      }

      // Disconnect old pipeline
      try {
        audioSourceRef.current?.disconnect();
      } catch {}
      try {
        audioGainRef.current?.disconnect();
      } catch {}

      const source = audioCtxRef.current!.createMediaStreamSource(stream);
      const gain = audioCtxRef.current!.createGain();
      gain.gain.value = audioGainRef.current?.gain.value ?? 1;
      source.connect(gain).connect(audioCtxRef.current!.destination);
      audioSourceRef.current = source;
      audioGainRef.current = gain;
    } catch {}
  }, []);

  const resumeAudio = useCallback(async () => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {}
    }
  }, []);

  // Bind remote stream to local media elements (video + audio)
  const bindRemoteStream = useCallback(
    (stream: MediaStream) => {
      remoteStreamRef.current = stream;
      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      addLog(
        `Binding remote stream - Video tracks: ${videoTracks.length}, Audio tracks: ${audioTracks.length}`,
        'info'
      );

      // Check audio track status
      audioTracks.forEach((track, index) => {
        addLog(
          `Audio track ${index}: enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`,
          'info'
        );
      });

      // Bind to video element
      const v = videoRef.current;
      if (v && v.srcObject !== stream) {
        v.srcObject = stream;
        v.setAttribute('playsinline', 'true');
        v.setAttribute('webkit-playsinline', 'true');
        // Initial state set to muted, waiting for user interaction to unlock
        v.muted = true;

        // 🚀 Low latency optimization: reduce browser internal buffering
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vAny = v as any;
        if ('playsInline' in v) vAny.playsInline = true;
        if ('latencyHint' in v) vAny.latencyHint = 0;
        v.style.transform = 'translateZ(0)';
        if ('disablePictureInPicture' in v) vAny.disablePictureInPicture = true;

        v.onloadedmetadata = () => {
          addLog(
            `Video metadata loaded - videoWidth: ${v.videoWidth}, videoHeight: ${v.videoHeight}`,
            'info'
          );
          v.play().catch(err => {
            addLog(`Video play failed: ${err.message}`, 'error');
          });
        };

        // Clear user-facing status only when video is actually rendering frames.
        v.onplaying = () => {
          addLog('Video started playing, viewer connected', 'info');
          updateViewerStatus('connected');
        };
      }

      // User interaction to unlock audio (supports desktop and mobile)
      if (!touchUnlockHandlerRef.current) {
        const doUnmute = () => {
          const vEl = videoRef.current;
          unmutedRef.current = true;

          addLog('User interaction detected, attempting to unmute audio...', 'info');

          if (vEl) {
            vEl.muted = false;
            vEl.volume = 1;
            vEl.play().catch(err => {
              addLog(`Video play after unmute failed: ${err.message}, retrying...`, 'warning');
              // Retry after a short delay in case of transient DOM race (e.g. HMR re-render)
              setTimeout(() => {
                const v2 = videoRef.current;
                if (v2) {
                  v2.muted = false;
                  v2.volume = 1;
                  v2.play().catch(() => {});
                }
              }, 300);
            });
          }

          void resumeAudio();
          addLog('Audio unlock completed', 'success');
        };

        const handler = () => {
          // Remove listeners first so they don't fire again
          document.removeEventListener('click', handler);
          document.removeEventListener('touchend', handler);
          document.removeEventListener('keydown', handler);
          touchUnlockHandlerRef.current = null;
          doUnmute();
        };
        touchUnlockHandlerRef.current = handler;

        // Listen to multiple user interaction events to unlock audio
        document.addEventListener('click', handler, { passive: true });
        document.addEventListener('touchend', handler, { passive: true });
        document.addEventListener('keydown', handler, { passive: true });

        addLog('Audio unlock handlers registered, waiting for user interaction...', 'info');
      }
    },
    [videoRef, audioRef, captureAudio, ensureAudioPipeline, resumeAudio, updateViewerStatus]
  );

  // WebRTC: Apply remote SDP
  const applyRemoteDescription = useCallback(async (sdp: string) => {
    const pc = peerConnectionRef.current;
    if (!pc) {
      addLog('No peer connection when trying to apply remote description', 'error');
      return;
    }

    try {
      const offerJson = JSON.parse(atob(sdp));
      // log('[WebRTC]ice backend answer returned, offerJson)', offerJson.sdp)

      await pc.setRemoteDescription(new RTCSessionDescription(offerJson));

      // Clear answer timeout timer
      if (answerTimeoutRef.current) {
        clearTimeout(answerTimeoutRef.current);
        answerTimeoutRef.current = null;
      }

      // Calculate response time
      const responseTime = offerSentTime.current ? Date.now() - offerSentTime.current : 0;
      log(`⏱️ Answer received in ${responseTime}ms`);

      log('📊 Peer connection state:', {
        signalingState: pc.signalingState,
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
        iceGatheringState: pc.iceGatheringState,
      });

      // Drain any ICE candidates that arrived before the remote description
      if (pendingCandidatesRef.current.length > 0) {
        const pending = pendingCandidatesRef.current.splice(0);
        for (const c of pending) {
          pc.addIceCandidate(c).catch(err =>
            logError('[WebRTC] Failed to add buffered ICE candidate:', err)
          );
        }
      }

      // Remote answer applied, waiting for media streams
      setConnectionStatusMessage(ConnectionStatusText.remoteAnswerApplied);
    } catch (error) {
      logError('❌ Failed to set remote description:', error);
      addLog(`Failed to set remote description: ${error}`);
    }
  }, []);

  // WebSocket
  const {
    sendMessage: _wsSendMessage,
    lastMessage: _lastMessage,
    readyState: _readyState,
    getWebSocket,
  } = useWebSocket(signalingUrl, {
    heartbeat: true,
    retryOnError: true,
    // WebSocket reconnection also uses externally passed parameters
    reconnectAttempts: reconnectAttempts,
    reconnectInterval: reconnectInterval,
    shouldReconnect: () => !manualCloseRef.current,
    onReconnectStop: numAttempts => {
      logError(`[WS] reconnect stopped after ${numAttempts} attempts, giving up`);
    },
    onOpen: () => {
      manualCloseRef.current = false;
      setConnectionState(prev => ({ ...prev, ws: 'connected' }));
      updateViewerStatus('ws_connecting', false);
      setConnectionStatusMessage(ConnectionStatusText.wsWaitingDeviceInfo);
    },
    onClose: (event: CloseEvent) => {
      // code 1006 = abnormal closure (handshake failed, TLS error, network down, ...)
      const isAbnormal = event?.code === 1006;
      // Keep this at info level during auto-reconnect; surface as error only
      // when the reconnect budget is exhausted (handled in onReconnectStop).
      log(
        `[WS] closed code=${event?.code} reason="${event?.reason || ''}" wasClean=${event?.wasClean}`
      );
      setConnectionState(prev => ({
        ...prev,
        ws: isAbnormal ? 'error' : 'disconnected',
      }));
      setConnectionStatusMessage(
        isAbnormal ? ConnectionStatusText.wsError : ConnectionStatusText.wsDisconnected
      );
      if (manualCloseRef.current) {
        updateViewerStatus('closed');
      } else {
        updateViewerStatus('reconnecting');
      }
    },
    onError: _e => {
      // Browser emits an 'error' event for every handshake failure but hides
      // the cause. Real detail surfaces in the following onClose.
      // Kept silent here to avoid log spam during auto-reconnect loops.

      setConnectionState(prev => ({ ...prev, ws: 'error' }));
      setConnectionStatusMessage(ConnectionStatusText.wsError);
      updateViewerStatus('failed');
    },
    onMessage: async event => {
      const eventData = event.data;

      if (eventData === 'pong') return;

      const message = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;
      const { type, data } = message || {};
      if (!type) return;

      if (type === 'error') {
        const code = data?.code ?? '';
        const errorMessage = data?.message ?? 'Unknown signaling error';
        logWarn('[WS] signaling error: %s — %s', code, errorMessage);
        if (code === 'agentSlotOccupied') {
          manualCloseRef.current = true;
          updateViewerStatus('failed');
          setConnectionStatusMessage(errorMessage);
          getWebSocket()?.close();
        }
        return;
      }

      if (type === 'device-metadata') {
        const { deviceVersion } = data || {};
        const minted = parseMintedClientId(message);
        if (minted) {
          signalingIdentityRef.current.cloudClientId = minted;
        }
        if (!deviceVersion) return;

        setConnectionState(prev => ({ ...prev, webrtc: 'connecting' }));
        updateViewerStatus('negotiating');
        setConnectionStatusMessage(ConnectionStatusText.deviceInfoReceived);
        startWebRTC();
        return;
      }

      if (type === 'answer') {
        log('[WebRTC][%d] Received answer from server', Date.now());
        const pc = peerConnectionRef.current;
        if (!pc) {
          logError('[WebRTC][%d] No PeerConnection when answer received!', Date.now());
          return;
        }

        log('[WebRTC][%d] State before applying answer:', Date.now(), {
          signalingState: pc.signalingState,
          iceConnectionState: pc.iceConnectionState,
          connectionState: pc.connectionState,
        });
        if (peerConnectionRef.current !== pc || pc.signalingState !== 'have-local-offer') {
          log(
            '[WebRTC][%d] Ignoring answer; signalingState=%s',
            Date.now(),
            pc.signalingState
          );
          return;
        }
        const answerPayload = message?.sd || data;
        if (typeof answerPayload !== 'string') {
          addLog(`Unexpected answer payload type: ${typeof answerPayload}`, 'warning');
          return;
        }
        const sid = parseSessionId(message);
        if (sid) {
          signalingIdentityRef.current.webrtcSessionId = sid;
          log('[WebRTC] Cloud session_id cached: %s', sid);
        }
        const held = outboundIceGateRef.current.flush(signalingIdentityRef.current);
        for (const c of held) {
          sendWebRTCSignalRef.current('new-ice-candidate', c);
        }
        applyRemoteDescription(answerPayload);
        return;
      }

      if (type !== 'new-ice-candidate' && type !== 'ice') return;

      const candidatePayload = message?.candidate || data?.candidate || message?.data || data;
      const candidate: RTCIceCandidateInit | null =
        typeof candidatePayload === 'string'
          ? {
              candidate: candidatePayload,
              sdpMid: data?.sdpMid,
              sdpMLineIndex: data?.sdpMLineIndex,
              usernameFragment: data?.usernameFragment,
            }
          : candidatePayload;
      const pc = peerConnectionRef.current;
      if (!candidate || !pc) return;

      if (!pc.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }

      pc.addIceCandidate(candidate).catch(err => {
        logError('[WebRTC][%d] Failed to add ICE candidate:', Date.now(), err);
        addLog(`Failed to add ICE candidate: ${err.message}, signalingState=${pc.signalingState}`);
      });
    },
  });
  // Send WebRTC signal (cloud stamps client_id / session_id via identity helpers).
  const sendWebRTCSignal = useCallback((type: string, data: unknown) => {
    const ws = getWebSocket();
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = buildSignalingOutbound(
        signalingIdentityRef.current,
        type,
        data
      );
      const messageStr = JSON.stringify(message);
      ws.send(messageStr);
    } else {
      logError('[WebRTC][%d] Cannot send signal: WebSocket not open', Date.now(), {
        type,
        wsState: ws?.readyState,
      });
    }
  }, [getWebSocket]);
  sendWebRTCSignalRef.current = sendWebRTCSignal;

  const rebindRemoteMediaToLiveEdge = useCallback(() => {
    const stream = remoteStreamRef.current;
    const video = videoRef.current;
    if (!stream || !video) return;

    const freshStream = new MediaStream(stream.getTracks());
    remoteStreamRef.current = freshStream;

    try {
      video.pause();
      video.srcObject = null;
      video.load();
    } catch {}

    requestAnimationFrame(() => {
      const currentVideo = videoRef.current;
      if (!currentVideo) return;

      try {
        currentVideo.srcObject = freshStream;
        currentVideo.setAttribute('playsinline', 'true');
        currentVideo.setAttribute('webkit-playsinline', 'true');
        currentVideo.muted = !unmutedRef.current;
        currentVideo.play().catch(() => {});
      } catch {}
    });
  }, [videoRef]);

  const requestRemoteKeyFrame = useCallback(
    (reason: string) => {
      sendWebRTCSignal('request-keyframe', {
        reason,
        forceIdr: true,
        ts: Date.now(),
      });
      addLog(`Requested remote keyframe: ${reason}`, 'info');
    },
    [sendWebRTCSignal]
  );

  const clearDataChannelBacklog = useCallback(() => {
    const channels = dataChannelsRef.current;
    if (!channels) return;

    Object.values(channels).forEach(channel => {
      try {
        channel.bufferedAmountLowThreshold = 0;
      } catch {}
    });
  }, []);
  // WebRTC disconnect: thoroughly clean up PeerConnection, media tracks and local media elements.
  // Forced reconnects can keep media attached so the last video frame remains visible
  // while a replacement PeerConnection is negotiated.
  const stopWebRTCReconnectionAndCleanup = useCallback(
    (options?: { keepMedia?: boolean }) => {
      clearDataChannelBacklog();

      // 1. Detach media elements first (stop decoding/rendering immediately)
      const v = videoRef.current;
      if (v && !options?.keepMedia) {
        v.srcObject = null;
      }

      const a = audioRef.current;
      if (a && !options?.keepMedia) {
        a.srcObject = null;
      }

      // 2. Close all DataChannels (clear handlers + close)
      const dcs = dataChannelsRef.current;
      if (dcs) {
        try {
          // DataChannels is an object with channel properties
          const channels = Object.values(dcs).filter(
            (ch): ch is RTCDataChannel => ch instanceof RTCDataChannel
          );
          channels.forEach(dc => {
            try {
              dc.onopen = null;
              dc.onclose = null;
              dc.onmessage = null;
              dc.onerror = null;
              if (dc.readyState !== 'closed') {
                dc.close();
              }
            } catch {}
          });
        } catch {}
      }
      dataChannelsRef.current = null;

      // 3. Clear all PeerConnection event handlers (prevent memory leaks)
      const pc = peerConnectionRef.current;
      if (pc) {
        try {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.ondatachannel = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;
          pc.onsignalingstatechange = null;
          pc.onnegotiationneeded = null;
        } catch {}

        // 4. Stop all sender tracks (local media: mic/camera/screen)
        try {
          pc.getSenders().forEach(sender => {
            try {
              sender.track?.stop();
            } catch {}
          });
        } catch {}

        if (!options?.keepMedia) {
          // 5. Stop all receiver tracks (remote media)
          try {
            pc.getReceivers().forEach(receiver => {
              try {
                receiver.track?.stop();
              } catch {}
            });
          } catch {}
        }

        // 6. Close PeerConnection
        try {
          pc.close();
        } catch {}

        peerConnectionRef.current = null;
      }

      // 7. Stop and clear remote stream reference
      const remoteStream = remoteStreamRef.current;
      if (remoteStream && !options?.keepMedia) {
        try {
          remoteStream.getTracks().forEach(track => {
            try {
              track.stop();
            } catch {}
          });
        } catch {}
        remoteStreamRef.current = null;
      }

      // 8. Clear negotiation state and flags
      isCreatingOffer.current = false;
      pendingCandidatesRef.current = [];
      outboundIceGateRef.current.clear();
      clearWebRTCSessionId(signalingIdentityRef.current);
      if (answerTimeoutRef.current !== null) {
        window.clearTimeout(answerTimeoutRef.current);
        answerTimeoutRef.current = null;
      }

      // 9. Update connection state
      setPeerConnectionState('closed');
      onPeerConnectionStateChange?.('closed');
      setConnectionState({ ws: 'closed', webrtc: 'closed' });
      updateViewerStatus('closed');
    },
    [videoRef, audioRef, clearDataChannelBacklog]
  );
  // WebSocket disconnect
  const stopWebSocketReconnectionAndCleanup = useCallback(() => {
    manualCloseRef.current = true;
    stopWebRTCReconnectionAndCleanup();
    // Actively close underlying WebSocket to prevent subsequent reconnection
    try {
      const ws = getWebSocket();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, 'client disconnect');
      }
    } catch {}
  }, []);

  const setupTransceiversAndCodecs = useCallback(
    (pc: RTCPeerConnection) => {
      try {
        if (viewOnly) {
          // View-only: only receive video (and optionally audio), no send channels or data channels needed
          const vTrans = pc.addTransceiver('video', { direction: 'recvonly' });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const caps = (RTCRtpReceiver as any).getCapabilities?.('video');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const codecs: any[] | undefined = caps?.codecs;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (Array.isArray(codecs) && (vTrans as any).setCodecPreferences) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const h264 = codecs.filter((c: any) => /H264/i.test(c.mimeType));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const others = codecs.filter((c: any) => !/H264/i.test(c.mimeType));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try {
              (vTrans as any).setCodecPreferences(h264.concat(others));
            } catch {}
          }

          if (captureAudio) {
            const aTrans = pc.addTransceiver('audio', { direction: 'recvonly' });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const acaps = (RTCRtpReceiver as any).getCapabilities?.('audio');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (acaps?.codecs && (aTrans as any)?.setCodecPreferences) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pcma = acaps.codecs.filter((c: any) => /PCMA/i.test(c.mimeType));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const rest = acaps.codecs.filter((c: any) => !/PCMA/i.test(c.mimeType));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              try {
                (aTrans as any).setCodecPreferences([...pcma, ...rest]);
              } catch {}
            }
          }
          return;
        }

        // 1. Reserve send channels. Order must stay aligned with MediaDeviceControl lookup logic.
        //    sendOnlyTransceivers[0] is the audio send channel.
        const audioSendTrans = pc.addTransceiver('audio', {
          direction: 'sendonly',
        });

        // Set send-side audio codec preferences: PCMA first, 8kHz mono (G.711 A-law).
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sendCaps = (RTCRtpSender as any).getCapabilities?.('audio');

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (sendCaps?.codecs && (audioSendTrans as any).setCodecPreferences) {
            // Prefer PCMA and keep other codecs as fallback for compatibility.
            const pcmaCodecs = sendCaps.codecs.filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (c: any) => /PCMA/i.test(c.mimeType)
            );
            const otherCodecs = sendCaps.codecs.filter(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (c: any) => !/PCMA/i.test(c.mimeType)
            );

            const orderedSendCodecs = [...pcmaCodecs, ...otherCodecs];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (audioSendTrans as any).setCodecPreferences(orderedSendCodecs);
            addLog(
              `Audio SEND codec: PCMA preferred, total ${orderedSendCodecs.length} codecs (compatible)`,
              'info'
            );
          } else {
            logger.warn(
              'setCodecPreferences not available on send transceiver or no codecs'
            );
          }
        } catch (e) {
          addLog(
            `Failed to set audio send codec preferences: ${e instanceof Error ? e.message : String(e)}`,
            'warning'
          );
        }

        // Configure audio encoding parameters.
        try {
          const audioSender = audioSendTrans.sender;
          const audioParams = audioSender.getParameters() || {};
          audioParams.encodings = audioParams.encodings ?? [{}];

          // Compatibility mode: 96kbps covers PCMA (64kbps) and Opus fallback.
          audioParams.encodings[0].maxBitrate = 96_000;
          audioParams.encodings[0].priority = 'high';

          void audioSender.setParameters(audioParams);
          addLog('Audio encoding: maxBitrate=96kbps, priority=high (compatible)', 'info');
        } catch {
          addLog('Audio encoding parameters not supported', 'warning');
        }

        //    The second sendonly transceiver is the video send channel.
        const videoSendTrans = pc.addTransceiver('video', {
          direction: 'sendonly',
        });

        // Optionally limit outbound video bitrate (example: 800 kbps)
        try {
          const sender = videoSendTrans.sender;
          const params = sender.getParameters() || {};
          params.encodings = params.encodings ?? [{}];
          // maxBitrate is in bits per second
          params.encodings[0].maxBitrate = 800_000;
          void sender.setParameters(params);
        } catch {
          // Silently ignore if the browser does not support setParameters
        }

        // 2. Receive channels for remote audio/video playback.
        const vTrans = pc.addTransceiver('video', { direction: 'recvonly' });

        const aTrans = pc.addTransceiver('audio', { direction: 'recvonly' });
        // Set receive-side audio codec preferences: PCMA first, 8kHz mono (G.711 A-law).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acaps = (RTCRtpReceiver as any).getCapabilities?.('audio');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (acaps?.codecs && (aTrans as any)?.setCodecPreferences) {
          // Prefer PCMA and keep other codecs as fallback for compatibility.
          const pcmaCodecs = acaps.codecs.filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c: any) => /PCMA/i.test(c.mimeType)
          );
          const otherCodecs = acaps.codecs.filter(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c: any) => !/PCMA/i.test(c.mimeType)
          );
          const sortedCodecs = [...pcmaCodecs, ...otherCodecs];

          if (sortedCodecs.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (aTrans as any).setCodecPreferences(sortedCodecs);
            addLog(
              `Audio RECV codec: PCMA preferred, total ${sortedCodecs.length} codecs (compatible mode)`,
              'info'
            );
          } else {
            addLog('No supported audio codecs found, falling back to defaults', 'warning');
          }
        } else {
          addLog('Browser does not support setting audio codec preferences', 'warning');
        }
        //
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const caps = (RTCRtpReceiver as any).getCapabilities?.('video');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const codecs: any[] | undefined = caps?.codecs;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (Array.isArray(codecs) && (vTrans as any).setCodecPreferences) {
          const h264 = codecs.filter(c => /H264/i.test(c.mimeType));
          const others = codecs.filter(c => !/H264/i.test(c.mimeType));
          const ordered = h264.concat(others);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vTrans as any).setCodecPreferences(ordered);
            addLog('Video codec preferences set (H.264 preferred)', 'info');
          } catch (e) {
            addLog(
              `Failed to set video codec preferences: ${e instanceof Error ? e.message : String(e)}`,
              'warning'
            );
          }
        }
      } catch {}
    },
    [peerConnectionRef]
  );
  // WebRTC
  const startWebRTC = useCallback(() => {
    beginNegotiation(signalingIdentityRef.current);
    outboundIceGateRef.current.clear();
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch {}
      peerConnectionRef.current = null;
    }
    let pc: RTCPeerConnection;
    try {
      let validIceServers: RTCIceServer[] | undefined;
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        validIceServers = iceServers.map(server => ({
          ...server,
          urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        }));
      }
      // Creating peer connection...
      updateViewerStatus('initializing');
      setConnectionStatusMessage(ConnectionStatusText.creatingPeerConnection);
      const configuration: RTCConfiguration = {
        ...(env.target === 'cloud'
          ? {
              iceServers: validIceServers,
              // Cloud relies on TURN only; skip host/srflx to cut ~80% ICE
              // candidates and avoid pointless direct-connect attempts.
              // iceTransportPolicy: 'relay',
            }
          : {}),
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        ...rtcConfig,
      };
      if (configuration.iceServers?.length === 0) {
        delete configuration.iceServers;
        // relay policy makes no sense without TURN servers
        delete (configuration as RTCConfiguration).iceTransportPolicy;
      }
      pc = new RTCPeerConnection(configuration);
      setPeerConnectionState(pc.connectionState);
      onPeerConnection?.(pc);
    } catch {
      stopWebRTCReconnectionAndCleanup();
      return;
    }

    peerConnectionRef.current = pc;
    setupTransceiversAndCodecs(pc);

    // Try to attach WebRTC Encoded Transform to inbound video tracks (experimental API).
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AnyWindow = window as any;
      const ScriptTransform = AnyWindow.RTCRtpScriptTransform;

      if (ScriptTransform) {
        // Clean up the previous worker to avoid memory leaks.
        if (videoTransformWorkerRef.current) {
          try {
            videoTransformWorkerRef.current.terminate();
          } catch {}
          videoTransformWorkerRef.current = null;
        }
        const worker = new Worker(new URL('../webrtc/videoTransform.worker.ts', import.meta.url), {
          type: 'module' as 'classic' | 'module',
        });
        videoTransformWorkerRef.current = worker;

        pc.getReceivers().forEach(receiver => {
          try {
            if (receiver.track?.kind !== 'video') return;
            // Some browsers expose `transform` directly on receiver.
            if (!('transform' in receiver)) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (receiver as any).transform = new ScriptTransform(worker, {
              kind: 'video',
            });
          } catch {
            // Ignore per-receiver failures.
          }
        });
      }
    } catch {
      // Ignore unsupported or creation-failure cases.
    }

    // Create data channels (skipped in view-only mode).
    if (!viewOnly) {
      createDataChannels(pc);
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      setPeerConnectionState(state);
      onPeerConnectionStateChange?.(state);
      if (state === 'connected') {
        clearDataChannelBacklog();
        rebindRemoteMediaToLiveEdge();
        requestRemoteKeyFrame('peer_connection_connected');
      } else if (state === 'disconnected') {
        clearDataChannelBacklog();
        updateViewerStatus('reconnecting');
      } else if (state === 'failed') {
        clearDataChannelBacklog();
        updateViewerStatus('failed');
      } else if (state === 'closed') {
        clearDataChannelBacklog();
        updateViewerStatus('closed');
      }
      addLog(`onconnectionstatechange:${new Date().getTime()}`);
    };
    pc.onsignalingstatechange = () => {
      addLog(`onsignalingstatechange:${new Date().getTime()}`);
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (!state) {
        return;
      }
      log('[WebRTC][%d] ICE connection state: %s', Date.now(), state);
      setConnectionState(prev => ({ ...prev, webrtc: state }));
      if (IceConnectionStateMessage[state]) {
        setConnectionStatusMessage(IceConnectionStateMessage[state]);
      }
      if (state === 'checking') {
        updateViewerStatus('ice_checking');
      } else if (state === 'connected' || state === 'completed') {
        clearDataChannelBacklog();
        rebindRemoteMediaToLiveEdge();
        requestRemoteKeyFrame(`ice_${state}`);
        updateViewerStatus('waiting_media');
      } else if (state === 'disconnected') {
        clearDataChannelBacklog();
        updateViewerStatus('reconnecting');
      } else if (state === 'failed') {
        clearDataChannelBacklog();
        updateViewerStatus('failed');
      } else if (state === 'closed') {
        clearDataChannelBacklog();
        updateViewerStatus('closed');
      }
      addLog(`oniceconnectionstatechange:${new Date().getTime()},type:${state}`);

      // Diagnostic log: print candidate details when ICE fails/disconnects.
      if (state === 'failed' || state === 'disconnected') {
        logWarn(
          '[WebRTC][%d] ICE connection failed/disconnected, checking candidates...',
          Date.now()
        );
        const transceivers = pc.getTransceivers();
        addLog(`Transceivers count: ${transceivers.length}`, 'info');
        pc.getStats().then(stats => {
          const candidates = { local: [], remote: [] };
          stats.forEach(report => {
            if (report.type === 'local-candidate') {
              candidates.local.push(report);
            } else if (report.type === 'remote-candidate') {
              candidates.remote.push(report);
            }
          });
          log('ICE Candidates:', candidates);
          if (candidates.local.length === 0) {
            logError('⚠️ No local ICE candidates gathered!');
          }
          if (candidates.remote.length === 0) {
            logError('⚠️ No remote ICE candidates received!');
          }
        });
      }
    };

    pc.onnegotiationneeded = async () => {
      if (pc.signalingState !== 'stable' || isCreatingOffer.current) {
        return;
      }
      try {
        isCreatingOffer.current = true;
        beginNegotiation(signalingIdentityRef.current);
        outboundIceGateRef.current.clear();
        updateViewerStatus('negotiating');
        log('🔷 Negotiation needed, creating offer...');
        setConnectionStatusMessage(NegotiationStatusMessage.creatingLocalOffer);

        const offer = await pc.createOffer();
        log('✅ Offer created:', {
          type: offer.type,
          sdpLength: offer.sdp?.length || 0,
        });

        await pc.setLocalDescription(offer);
        log('✅ Local description set (offer)');
        log('📤 Sending offer to server via WebSocket...');

        const sd = btoa(JSON.stringify(pc.localDescription));
        log('📋 Offer details:', {
          type: pc.localDescription?.type,
          sdpLength: pc.localDescription?.sdp?.length || 0,
          sdpPreview: pc.localDescription?.sdp?.substring(0, 100) + '...',
          encodedLength: sd.length,
        });
        log('📦 Message format:', {
          type: 'offer',
          dataKeys: Object.keys({ sd }),
          sdPreview: sd.substring(0, 50) + '...',
        });

        // Keep outgoing format consistent with answer handling.
        // Server expects { type: 'offer', sd: '...' } with `sd` at top level,
        // not { type: 'offer', data: { sd: '...' } }.

        sendWebRTCSignal('offer', { sd });
        offerSentTime.current = Date.now();
        log('✅ Offer sent to server');
        setConnectionStatusMessage(NegotiationStatusMessage.waitingRemoteAnswer);

        // Set answer timeout check (10 seconds).
        if (answerTimeoutRef.current) {
          clearTimeout(answerTimeoutRef.current);
        }
        answerTimeoutRef.current = window.setTimeout(() => {
          answerTimeoutRef.current = null;

          // Ignore a stale timeout from a replaced PeerConnection or an
          // answer that arrived at the timeout boundary.
          if (peerConnectionRef.current !== pc || pc.remoteDescription) {
            return;
          }

          logError('❌ Answer timeout: No response from server after 10 seconds');
          logError('🔍 Possible causes:');
          logError('  1. Server not receiving offer');
          logError('  2. Server WebRTC not initialized');
          logError('  3. Server processing error');
          logError('  4. WebSocket connection issue');
          log('📊 Current state:', {
            signalingState: pc.signalingState,
            iceConnectionState: pc.iceConnectionState,
            connectionState: pc.connectionState,
            iceGatheringState: pc.iceGatheringState,
          });

          // Move out of the transient "connecting" state so the existing
          // failed-state retry effect can negotiate a fresh PeerConnection.
          setConnectionState(prev => ({ ...prev, webrtc: 'failed' }));
          setPeerConnectionState('failed');
          onPeerConnectionStateChange?.('failed');
          updateViewerStatus('failed');
        }, 10000);
      } catch {
        stopWebRTCReconnectionAndCleanup();
      } finally {
        isCreatingOffer.current = false;
      }
    };

    pc.onicecandidate = event => {
      const candidate = event.candidate;
      const ws = getWebSocket();
      const wsReadyState = ws?.readyState;

      if (!candidate) {
        addLog('onicecandidate: gathering complete');
        log('✅ ICE gathering complete');
      }

      if (!candidate || wsReadyState !== WebSocket.OPEN) {
        return;
      }

      // Use toJSON() to send normalized RTCIceCandidateInit format.
      // This helps keep compatibility with the Rust WebRTC backend.
      const candidateInit = candidate.toJSON();
      const ready = outboundIceGateRef.current.push(
        signalingIdentityRef.current,
        candidateInit
      );
      for (const c of ready) {
        sendWebRTCSignal('new-ice-candidate', c);
      }
    };

    pc.onicegatheringstatechange = () => {
      const iceGatheringState = pc.iceGatheringState;
      const mesObj: Record<string, string> = {
        complete: ConnectionStatusText.iceGatheringComplete,
        gathering: ConnectionStatusText.iceGathering,
      };
      if (mesObj[iceGatheringState]) {
        setConnectionStatusMessage(mesObj[iceGatheringState]);
      }
      if (iceGatheringState === 'gathering') {
        updateViewerStatus('ice_gathering');
      } else if (iceGatheringState === 'complete') {
        updateViewerStatus('waiting_connection');
      }
      addLog(`onicegatheringstatechange:${new Date().getTime()}`);
    };

    pc.ontrack = event => {
      updateViewerStatus('media_loading');
      addLog(
        `PC ontrack event - Track kind: ${event.track.kind}, transceivers: ${pc.getTransceivers().length}`,
        'info'
      );
      const receiver = event.receiver;
      receiver.playoutDelayHint = 0;
      if (receiver.track.kind === 'video') {
        addLog('Set video playoutDelayHint = 0', 'info');
      } else if (receiver.track.kind === 'audio') {
        addLog(
          `Audio track received - enabled: ${event.track.enabled}, muted: ${event.track.muted}, readyState: ${event.track.readyState}`,
          'info'
        );
      }
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      // Track arrived but video element may not be rendering yet.
      // Final clear happens in videoRef.onplaying below.
      setConnectionStatusMessage(ConnectionStatusText.mediaTrackReceived);
      if (stream) {
        bindRemoteStream(stream);
      } else {
        addLog('⚠️ No streams in ontrack event, will create MediaStream manually');
      }
    };
  }, [
    iceServers,
    rtcConfig,
    env,
    setConnectionStatusMessage,
    stopWebRTCReconnectionAndCleanup,
    setupTransceiversAndCodecs,
    createDataChannels,
    clearDataChannelBacklog,
    rebindRemoteMediaToLiveEdge,
    requestRemoteKeyFrame,
    setConnectionState,
    updateViewerStatus,
    getWebSocket,
    sendWebRTCSignal,
    bindRemoteStream,
    onPeerConnection,
    onPeerConnectionStateChange,
  ]);

  // Manually trigger one WebRTC reconnect (only valid when WebSocket is connected).
  const reconnect = useCallback(
    (force = false) => {
      // Allow follow-up automatic reconnection.
      manualCloseRef.current = false;

      const ws = getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      // Re-start WebRTC negotiation when not connected or already failed.
      const state = connectionState.webrtc;
      if (!force && state === 'connected') return;

      try {
        stopWebRTCReconnectionAndCleanup({ keepMedia: force });
      } catch {}
      startWebRTC();
    },
    [connectionState.webrtc, getWebSocket, startWebRTC, stopWebRTCReconnectionAndCleanup]
  );
  // Auto-reconnect based on WebRTC state (supports retry count and exponential backoff).
  useEffect(() => {
    if (!shouldReconnect) return;

    const state = connectionState.webrtc;

    // Reset reconnect attempts and timer when connection is healthy.
    if (state === 'connected' || state === 'new') {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptsRef.current = 0;
      return;
    }

    // Attempt reconnect only when failed or disconnected.
    if (state === 'failed' || state === 'disconnected') {
      if (
        reconnectAttempts &&
        reconnectAttempts > 0 &&
        reconnectAttemptsRef.current >= reconnectAttempts
      ) {
        return;
      }

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      const attempt = reconnectAttemptsRef.current;
      const baseInterval = reconnectInterval ?? 3000;
      const factor = reconnectBackoffFactor ?? 1.5;
      const maxDelay = maxReconnectDelay ?? 30000;

      // disconnected may be a transient blip; give it a grace period before
      // tearing things down. failed is terminal, retry on regular backoff.
      const DISCONNECTED_GRACE_MS = 5000;
      const backoffDelay = Math.min(baseInterval * Math.pow(factor, attempt), maxDelay);
      const delay =
        state === 'disconnected' ? Math.max(DISCONNECTED_GRACE_MS, backoffDelay) : backoffDelay;

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;

        // Re-check live peer connection state. If it has already recovered
        // (e.g. ICE re-established during the grace period), skip restart.
        const livePc = peerConnectionRef.current;
        const liveState = livePc?.iceConnectionState;
        if (liveState === 'connected' || liveState === 'completed' || liveState === 'checking') {
          reconnectAttemptsRef.current = 0;
          return;
        }

        reconnectAttemptsRef.current += 1;
        startWebRTC();
      }, delay);
    }

    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [
    connectionState.webrtc,
    shouldReconnect,
    reconnectAttempts,
    reconnectInterval,
    reconnectBackoffFactor,
    maxReconnectDelay,
    startWebRTC,
  ]);

  // Force close connections before page unload to avoid server-side leaks.
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Must run synchronously; async behavior is unreliable during beforeunload.
      const ws = getWebSocket();
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Notify server before closing.
        try {
          ws.send(JSON.stringify({ type: 'client-closing' }));
        } catch {}
        // Close WebSocket immediately.
        try {
          ws.close(1000, 'page unload');
        } catch {}
      }
      // Close PeerConnection.
      try {
        peerConnectionRef.current?.close();
      } catch {}
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [getWebSocket]);

  // Ensure WebRTC resources are cleaned up on component unmount.
  useEffect(() => {
    return () => {
      stopWebSocketReconnectionAndCleanup();
      // Close audio context.
      try {
        audioCtxRef.current?.close();
      } catch {}
      if (touchUnlockHandlerRef.current) {
        document.removeEventListener('click', touchUnlockHandlerRef.current);
        document.removeEventListener('touchend', touchUnlockHandlerRef.current);
        document.removeEventListener('keydown', touchUnlockHandlerRef.current);
        touchUnlockHandlerRef.current = null;
      }
      // Clean up video transform worker.
      if (videoTransformWorkerRef.current) {
        try {
          videoTransformWorkerRef.current.terminate();
        } catch {}
        videoTransformWorkerRef.current = null;
      }
    };
  }, [stopWebSocketReconnectionAndCleanup]);

  // Get current peer ICE identity fields and states.
  const getPeerId = useCallback(() => {
    const pc = peerConnectionRef.current;
    if (!pc) return null;

    return {
      // Local ICE ufrag.
      localUfrag: pc.localDescription?.sdp.match(/a=ice-ufrag:(.+)/)?.[1] || null,
      // Local ICE password.
      localPwd: pc.localDescription?.sdp.match(/a=ice-pwd:(.+)/)?.[1] || null,
      // Remote ICE ufrag.
      remoteUfrag: pc.remoteDescription?.sdp.match(/a=ice-ufrag:(.+)/)?.[1] || null,
      // Remote ICE password.
      remotePwd: pc.remoteDescription?.sdp.match(/a=ice-pwd:(.+)/)?.[1] || null,
      // Connection state.
      state: pc.connectionState,
      // Signaling state.
      signalingState: pc.signalingState,
    };
  }, []);

  // Expose hook API.
  return {
    connectionState,
    viewerStatus,
    connectionStatusMessage,
    videoRef,
    unmute: () => {
      const v = videoRef.current;
      const a = audioRef.current;
      unmutedRef.current = true;
      if (v) {
        v.muted = false;
        v.volume = 1;
        v.play().catch(() => {});
      }
      if (a) {
        a.muted = false;
        a.volume = 1;
        a.play().catch(() => {});
      }
      void resumeAudio();
    },
    boostAudio: (gain: number) => {
      if (!audioGainRef.current) return;
      audioGainRef.current.gain.value = Math.max(0, gain);
    },
    resumeAudio,
    reconnect,
    disconnect: stopWebSocketReconnectionAndCleanup,
    peerConnection: peerConnectionRef.current,
    peerConnectionState,
    getPeerId,
  };
};
