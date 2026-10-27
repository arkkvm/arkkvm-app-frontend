import { useRTCStore } from '@/stores';
import { createLogger } from '@/utils/logger';
import {
  type InputMethodName,
  type InputMethodParamsMap,
  type InputSend,
} from '@/utils/protobuf/inputMessage';
import { useCallback, useEffect, useMemo, useRef } from 'react';

const logger = createLogger('useInputChannel');
const INPUT_BUFFERED_AMOUNT_LIMIT = 256 * 1024;

export function useInputChannel() {
  const inputChannel = useRTCStore(s => s.inputChannel);
  const inputUnstableChannel = useRTCStore(s => s.inputUnstableChannel);
  const isChannelReady = !!inputChannel && inputChannel.readyState === 'open';

  const channelRef = useRef<RTCDataChannel | null>(null);
  const keyboardChannelRef = useRef<RTCDataChannel | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    channelRef.current = inputChannel ?? null;
    keyboardChannelRef.current = inputChannel ?? null;
    if (!inputChannel) return;

    const handleUnavailable = () => {
      if (keyboardChannelRef.current === inputChannel) {
        keyboardChannelRef.current = null;
      }
      if (channelRef.current === inputChannel) {
        channelRef.current = null;
      }
    };

    inputChannel.addEventListener('close', handleUnavailable);
    inputChannel.addEventListener('error', handleUnavailable);
    return () => {
      inputChannel.removeEventListener('close', handleUnavailable);
      inputChannel.removeEventListener('error', handleUnavailable);
    };
  }, [inputChannel]);
  useEffect(() => {
    if (inputUnstableChannel?.readyState === 'open') {
      channelRef.current = inputUnstableChannel;
    }
    if (!inputUnstableChannel) return;

    const handleUnavailable = () => {
      if (channelRef.current === inputUnstableChannel) {
        channelRef.current = inputChannel?.readyState === 'open' ? inputChannel : null;
      }
    };

    inputUnstableChannel.addEventListener('close', handleUnavailable);
    inputUnstableChannel.addEventListener('error', handleUnavailable);
    return () => {
      inputUnstableChannel.removeEventListener('close', handleUnavailable);
      inputUnstableChannel.removeEventListener('error', handleUnavailable);
    };
  }, [inputChannel, inputUnstableChannel]);

  const send = useCallback(
    <M extends InputMethodName>(call: InputSend<M>, channel?: RTCDataChannel | null) => {
      // If channel is provided, use it; otherwise use channelRef.current
      const ch = channel ?? (call.method === 'keyboardReport' ? keyboardChannelRef.current : channelRef.current);
      if (!ch || ch.readyState !== 'open') return undefined;
      // Keyboard state transitions must remain ordered and must not be dropped:
      // dropping key-up can leave a key repeating on the remote device.
      if (call.method !== 'keyboardReport' && ch.bufferedAmount > INPUT_BUFFERED_AMOUNT_LIMIT) return undefined;
      idRef.current += 1;
      if (idRef.current > Number.MAX_SAFE_INTEGER) idRef.current = 1;

      const payload: InputFrame<M> = {
        jsonrpc: '2.0',
        method: call.method,
        params: call.params,
        id: idRef.current,
      };

      try {
        ch.send(JSON.stringify(payload));
        return idRef.current;
      } catch {
        return undefined;
      }
    },
    []
  );

  const sendKeyboardReport = useCallback(
    (report: InputMethodParamsMap['keyboardReport']) => {
      //        if(report.keys?.[0]){
      //           report.keys = [

      //   39, // Digit0

      //   30, // Digit1

      //   36, // Digit7

      //   30, // Digit1
      //   0,0

      // ];
      //         }
      send({ method: 'keyboardReport', params: report });
    },
    [send]
  );

  const sendRelMouseReport = useCallback(
    (report: InputMethodParamsMap['relMouseReport']) => {
      if (
        !Number.isInteger(report.dx) ||
        !Number.isInteger(report.dy) ||
        !Number.isInteger(report.buttons)
      ) {
        logger.warn('sendRelMouseReport: Invalid parameters, must be integers', report);
        return;
      }

      send({ method: 'relMouseReport', params: report });
    },
    [send]
  );

  const sendAbsMouseReport = useCallback(
    (report: InputMethodParamsMap['absMouseReport']) => {
      if (
        !Number.isInteger(report.x) ||
        !Number.isInteger(report.y) ||
        !Number.isInteger(report.buttons)
      ) {
        logger.warn('sendAbsMouseReport: Invalid parameters, must be integers', report);
        return;
      }

      send({ method: 'absMouseReport', params: report }, inputUnstableChannel);
    },
    [send, inputUnstableChannel]
  );

  const sendWheelReport = useCallback(
    (report: InputMethodParamsMap['wheelReport']) => {
      return send({ method: 'wheelReport', params: report }, inputUnstableChannel);
    },
    [send, inputUnstableChannel]
  );

  // Memoize the returned object to keep a stable reference for consumers.
  return useMemo(
    () => ({
      send,
      sendKeyboardReport,
      sendRelMouseReport,
      sendAbsMouseReport,
      sendWheelReport,
      isChannelReady,
    }),
    [
      send,
      sendKeyboardReport,
      sendRelMouseReport,
      sendAbsMouseReport,
      sendWheelReport,
      isChannelReady,
    ]
  );
}

export type UseInputChannelHandle = ReturnType<typeof useInputChannel>;
