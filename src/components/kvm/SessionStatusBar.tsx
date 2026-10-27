/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-05-15 18:00:58
 */
import { useVideoRenderFps } from '@/hooks/useVideoRenderFps';
import { useAppStore } from '@/stores';
import { useActiveDeviceSettings } from '@/stores/devicesStore';
import { cn } from '@/utils';
import { memo, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/shallow';
import { keys, modifiers } from '../VirtualKeyboard/data/hidKeyCodes';
import { useTranslation } from 'react-i18next';

interface SessionStatusBarProps {
  videoRef?: React.RefObject<HTMLVideoElement | null>
  peerState?: string
}

const LED_BASE_CLASS = 'text-[12px] rounded-[4px] px-[6px] py-[2px] border-[1px]';
const LED_ACTIVE_CLASS = 'text-(--primary) border-(--primary)';
const LED_INACTIVE_CLASS = 'text-(--text-secondary) border-(--border)';

const SessionStatusBar = ({ videoRef, peerState }: SessionStatusBarProps) => {
  const { t } = useTranslation('common');
  const agentControlOwner = useAppStore(s => s.agentControlOwner);
  const agentViewOnly = useAppStore(s => s.agentViewOnly);
  const mcpEnabled = useActiveDeviceSettings(s => s.mcpEnabled) === true;
  const showAgentState = mcpEnabled && agentControlOwner !== undefined;
  const emptyVideoRef = useRef<HTMLVideoElement | null>(null);

  // Batch store subscriptions with shallow comparison for better performance
  const {
    showDiagnosticInfo,
    showPressedKeys,
    showKeyboardLeds,
    videoWidth,
    videoHeight,
    containerWidth,
    containerHeight,
    mouseX,
    mouseY,
    hidUsbState,
    usbState,
    hdmiConnectionState,
    hidKeysDownState,
    keysDownState,
  } = useAppStore(
    useShallow(s => ({
      showDiagnosticInfo: s.showDiagnosticInfo,
      showPressedKeys: s.showPressedKeys,
      showKeyboardLeds: s.showKeyboardLeds,
      videoWidth: s.videoWidth,
      videoHeight: s.videoHeight,
      containerWidth: s.containerWidth,
      containerHeight: s.containerHeight,
      mouseX: s.mouseX,
      mouseY: s.mouseY,
      hidUsbState: s.hidUsbState,
      usbState: s.usbState,
      hdmiConnectionState: s.hdmiConnectionState,
      hidKeysDownState: s.hidKeysDownState,
      keysDownState: s.keysDownState,
    }))
  );

  const keyboardLedState = useAppStore(s => s.ui?.keyboardLedState);

  const videoFps = useVideoRenderFps(
    showDiagnosticInfo && videoRef ? videoRef : emptyVideoRef,
    [peerState, showDiagnosticInfo]
  );

  const actualUsbState = hidUsbState ?? usbState;
  const actualKeysDownState = hidKeysDownState ?? keysDownState;
  const displayKeys = useMemo(() => {
    if (!showPressedKeys) return '';
    const activeModifierMask = actualKeysDownState?.modifier || 0;
    const keysDown = actualKeysDownState?.keys || [];
    const modifierNames = Object.entries(modifiers)
      .filter(([_, mask]) => (activeModifierMask & mask) !== 0)
      .map(([name]) => name);
    const keyNames = Object.entries(keys)
      .filter(([_, value]) => keysDown.includes(value))
      .map(([name]) => name);

    return [...modifierNames, ...keyNames].join(', ');
  }, [actualKeysDownState, showPressedKeys]);

  // Only calculate rendered size when diagnostic info is shown
  const rendered = useMemo(() => {
    if (!showDiagnosticInfo) return { w: 0, h: 0 };
    const vw = Number(videoWidth) || 0;
    const vh = Number(videoHeight) || 0;
    const cw = Number(containerWidth) || 0;
    const ch = Number(containerHeight) || 0;
    if (!vw || !vh || !cw || !ch) return { w: cw, h: ch };
    const scale = Math.min(cw / vw, ch / vh);
    return { w: Math.round(vw * scale), h: Math.round(vh * scale) };
  }, [showDiagnosticInfo, videoWidth, videoHeight, containerWidth, containerHeight]);

  // Only calculate LED states when keyboard LEDs are shown
  const ledStates = useMemo(() => {
    if (!showKeyboardLeds) return { isCapsOn: false, isNumOn: false, isScrollOn: false };
    return {
      isCapsOn: !!keyboardLedState?.caps_lock,
      isNumOn: !!keyboardLedState?.num_lock,
      isScrollOn: !!keyboardLedState?.scroll_lock,
    };
  }, [showKeyboardLeds, keyboardLedState]);

  if (!showDiagnosticInfo && !showPressedKeys && !showKeyboardLeds && !showAgentState) {
    return null;
  }
  return (
    <div className="flex bg-(--bg-secondary) items-center justify-between px-[32px] py-[6px] border-t border-(--border-color) flex-wrap">
      <ul className="status-bar h-[24px] text-sub flex items-center gap-[26px] flex-wrap">

        {showDiagnosticInfo && (
          <>
            <li>
              Resolution: <span translate="no" className="notranslate">{videoWidth}x{videoHeight}</span>
            </li>
            <li>
              Video Size: <span translate="no" className="notranslate">{rendered.w}x{rendered.h}</span>
            </li>
            <li>
              Pointer: <span translate="no" className="notranslate">{mouseX}x{mouseY}</span>
            </li>
            <li>FPS: <span translate="no" className="notranslate">{videoFps !== null ? videoFps.toFixed(1) : 'N/A'}</span></li>
            <li>USB State: <span translate="no" className="notranslate">{actualUsbState}</span></li>
            <li>HDMI State: <span translate="no" className="notranslate">{hdmiConnectionState}</span></li>
          </>
        )}
        {showAgentState && (
          <li>{t(agentControlOwner === 'agent'
            ? 'controlLease.statusControlling'
            : agentViewOnly ? 'controlLease.statusViewOnly' : 'controlLease.statusNotControlling')}</li>
        )}
         {showPressedKeys && <li>Keys: <span translate="no" className="notranslate">{displayKeys}</span></li>}
      </ul>

      {showKeyboardLeds && (
        <div translate="no" className="notranslate flex gap-[8px]">
          <span className={cn(LED_BASE_CLASS, ledStates.isCapsOn ? LED_ACTIVE_CLASS : LED_INACTIVE_CLASS)}>
            Caps Lock
          </span>
          <span className={cn(LED_BASE_CLASS, ledStates.isNumOn ? LED_ACTIVE_CLASS : LED_INACTIVE_CLASS)}>
            Num Lock
          </span>
          <span className={cn(LED_BASE_CLASS, ledStates.isScrollOn ? LED_ACTIVE_CLASS : LED_INACTIVE_CLASS)}>
            Scroll Lock
          </span>
        </div>
      )}
    </div>
  );
};
export default memo(SessionStatusBar);
