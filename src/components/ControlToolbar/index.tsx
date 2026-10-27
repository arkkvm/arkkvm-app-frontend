import {
  IconCd,
  IconChartHistogramTwo,
  IconClipboard,
  IconFileTransfer,
  IconKeyboard,
  IconRing,
  IconRouter,
  IconSetting,
  IconTerminal,
} from '@/assets/icons';
import { Type } from 'lucide-react';
import { activeClass } from '@/components/ui/variants';
import { type JsonRpcHandle } from '@/hooks/useJsonRpc';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores';
import { useActiveDeviceSettings } from '@/stores/devicesStore';
import React, { memo, useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import Extension from '../kvm/Extension';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import MediaDeviceControl from './MediaDeviceControl';
import PasteText from './PasteText';
import VirtualMedia from './VirtualMedia';
import VirtualUsbDrive from './VirtualUsbDrive';
import WakeOnLAN from './WakeOnLAN';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';

export interface KeyboardEventData {
  /** Keyboard event type: keydown, keyup, keypress */
  type: 'keydown' | 'keyup' | 'keypress'
  /** Key code */
  keyCode?: number
  /** Key name */
  key?: string
  /** Whether Alt key is pressed */
  altKey?: boolean
  /** Whether Ctrl key is pressed */
  ctrlKey?: boolean
  /** Whether Shift key is pressed */
  shiftKey?: boolean
  /** Whether Meta key is pressed (Windows/Command key) */
  metaKey?: boolean
}

export interface MouseEventData {
  /** Mouse event type */
  type:
    | 'mousemove'
    | 'mousedown'
    | 'mouseup'
    | 'click'
    | 'dblclick'
    | 'contextmenu'
    | 'wheel'
  /** X coordinate (relative to remote screen) */
  x?: number
  /** Y coordinate (relative to remote screen) */
  y?: number
  /** Mouse button pressed: 0-left, 1-middle, 2-right */
  Button?: number
  /** Wheel event delta Y value */
  deltaY?: number
  /** Wheel event delta X value */
  deltaX?: number
}

export interface TerminalCommandData {
  /** Terminal command type */
  type: 'command' | 'signal'
  /** Command content */
  command?: string
  /** Signal type (e.g., Ctrl+C is SIGINT) */
  signal?: string
}

export interface FullScreenData {
  /** Fullscreen state change event */
  type: 'enter' | 'exit'
  /** Target element ID */
  targetElementId?: string
}

interface ControlToolbarProps {
  /** Keyboard control click event */
  onKeyboardClick?: (event: React.MouseEvent<HTMLElement>) => void
  /** Mouse control click event */
  onMouseClick?: (event: React.MouseEvent<HTMLElement>) => void
  /** Settings click event */
  onSettingClick?: (event: React.MouseEvent<HTMLElement>) => void
  /** Terminal click event */
  onTerminalClick?: (event: React.MouseEvent<HTMLElement>) => void
  /** Fullscreen click event */
  onFullScreenClick?: (event: React.MouseEvent<HTMLElement>, data?: FullScreenData) => void
  /** Exit fullscreen click event */
  onMinimizeClick?: (event: React.MouseEvent<HTMLElement>, data?: FullScreenData) => void
  /** Whether currently in fullscreen mode */
  isFullScreen?: boolean
  /** Current connection state */
  connectionState?: string
  /** Whether keyboard control is enabled */
  keyboardEnabled?: boolean
  /** Whether mouse control is enabled */
  mouseEnabled?: boolean
  /** Whether terminal is enabled */
  terminalEnabled?: boolean
  /** Paste text click event */
  onPasteTextClick?: (text?: string) => void
  onVirtualMediaClick?: () => void
  onWakeOnLanClick?: () => void
  onExtensionClick?: () => void
  onStatsClick?: () => void
  /** OCR text recognition click event */
  onOcrClick?: () => void
  /** Whether OCR text recognition is currently active */
  ocrEnabled?: boolean
  /** JSON-RPC handle */
  rpc: JsonRpcHandle
  /** Optional ref to imperatively close all toolbar popovers from parent */
  closeAllPopoversRef?: React.RefObject<(() => void) | null>
}

export default memo(function ControlToolbar({
  onKeyboardClick,
  onMouseClick: _onMouseClick,
  onSettingClick,
  onTerminalClick,
  onFullScreenClick: _onFullScreenClick,
  onMinimizeClick: _onMinimizeClick,
  isFullScreen: _isFullScreen = false,
  connectionState: _connectionState,
  keyboardEnabled = false,
  mouseEnabled: _mouseEnabled = false,
  terminalEnabled: _terminalEnabled = false,
  onPasteTextClick: _onPasteTextClick,
  onVirtualMediaClick: _onVirtualMediaClick,
  onWakeOnLanClick: _onWakeOnLanClick,
  onExtensionClick: _onExtensionClick,
  onStatsClick: _onStatsClick,
  onOcrClick,
  ocrEnabled: _ocrEnabled = false,
  closeAllPopoversRef,

  rpc,
}: ControlToolbarProps) {
  const [send, isChannelReady, sendAsync] = rpc;
  const visibleTerminal = useUiStore(s => s.visible.terminal);
  const visibleVirtualKeyboard = useUiStore(s => s.visible.virtualKeyboard);
  const toggleMain = useUiStore(s => s.toggleMain);
  const closeAllPanels = useUiStore(s => s.closeAllPanels);
  const [isVirtualMediaOpen, setIsVirtualMediaOpen] = useState(false);
  const [isPasteTextPanelOpen, setIsPasteTextPanelOpen] = useState(false);
  const [virtualMediaDialogOpen, setVirtualMediaDialogOpen] = useState(false);
  const virtualMediaInternalDialogsRef = React.useRef<(() => void) | null>(null);
  const [isVirtualUsbDriveOpen, setIsVirtualUsbDriveOpen] = useState(false);
  const [isWakeOnLanOpen, setIsWakeOnLanOpen] = useState(false);
  const [isCopyTextDropdownOpen, setIsCopyTextDropdownOpen] = useState(false);
  const [isExtensionOpen, setIsExtensionOpen] = useState(false);
  const webTerminalEnabled = useActiveDeviceSettings(
    state => state.webTerminalEnabled
  );
  const usbDeviceConfig = useActiveDeviceSettings(
    state => state.usbDeviceConfig
  );
  const fileTransfer = useActiveDeviceSettings(state => state.fileTransfer);
  const { t } = useTranslation('common');

  const popoverContentClassName = cn(
    'w-[520px] max-w-[90vw] bg-[var(--bg-secondary)]',
    'max-h-[80vh] flex flex-col',
    'data-[state=open]:animate-in data-[state=open]:fade-in-0',
    'data-[state=open]:slide-in-from-top-2 data-[state=open]:duration-300',
    'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
    'data-[state=closed]:slide-out-to-top-2 data-[state=closed]:duration-200',
    'data-[state=open]:ease-out data-[state=closed]:ease-in'
  );

  const buttonClassName = 'shrink-0 whitespace-nowrap';
  const getIconClassName = (_isEnabled: boolean, _defaultColor?: string) => {
    return `size-[12px] text-[12px] ${isChannelReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}
    }`;
  };

  // Close all popovers (mutual exclusion)
  const closeAllPopovers = useCallback(() => {
    setIsPasteTextPanelOpen(false);
    setIsVirtualMediaOpen(false);
    virtualMediaInternalDialogsRef.current?.();
    setIsVirtualUsbDriveOpen(false);
    setIsWakeOnLanOpen(false);
    setIsExtensionOpen(false);
  }, []);

  useEffect(() => {
    if (closeAllPopoversRef) {
      (closeAllPopoversRef as React.MutableRefObject<(() => void) | null>).current = closeAllPopovers;
    }
  }, [closeAllPopoversRef, closeAllPopovers]);

  // Close all other panels when opening a popover
  const openPopoverExclusive = useCallback(
    (setter: (open: boolean) => void, open: boolean) => {
      if (open) {
        closeAllPopovers();
        closeAllPanels();
      }
      setter(open);
    },
    [closeAllPopovers, closeAllPanels]
  );

  const handleKeyboardClick = (event: React.MouseEvent<HTMLElement>) => {
    if (isChannelReady) {
      if (onKeyboardClick) {
        return onKeyboardClick(event);
      }
      closeAllPopovers();
      toggleMain('virtualKeyboard');
    }
  };

  const handleSettingClick = (event: React.MouseEvent<HTMLElement>) => {
    if (isChannelReady) {
      if (onSettingClick) return onSettingClick?.(event);
      closeAllPopovers();
      toggleMain('settings');
    }
  };

  const handleTerminalClick = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (isChannelReady) {
      if (onTerminalClick) {
        return onTerminalClick(event);
      }
      closeAllPopovers();
      toggleMain('terminal');
    }
  };

  const handleOcrClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!isChannelReady) return;
    closeAllPopovers();
    onOcrClick?.();
  };

  return (
    <div className="flex w-full items-center gap-2 overflow-x-auto overscroll-x-contain border-b border-(--border-color) px-2 py-[6px] text-[#dbdbdb] sm:justify-between sm:overflow-visible sm:px-[18px]">
      {/* Left group */}
      <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
        {/* Web Terminal */}
        {webTerminalEnabled && (
          <Button
            variant="default"
            className={cn(buttonClassName, visibleTerminal && activeClass)}
            onMouseDown={e => {
              e.preventDefault();
              e.stopPropagation();
              handleTerminalClick(e);
            }}
            disabled={!isChannelReady}
            title={t('toolbar.webTerminal')}
          >
            <IconTerminal className={getIconClassName(visibleTerminal)} />
            <span>{t('toolbar.webTerminal')}</span>
          </Button>
        )}
        {/* Paste Text Split Button with Popover */}
        <Popover
          modal={false}
          open={isPasteTextPanelOpen}
          onOpenChange={open => {
            setIsPasteTextPanelOpen(open);
          }}
        >
          <div className="flex items-center -space-x-px">
            {/* Main Paste Text Button - as PopoverTrigger */}
            <PopoverTrigger asChild>
              <Button
                variant="default"
                className={cn(buttonClassName, 'rounded-r-none border-r-0')}
                disabled={!isChannelReady || !usbDeviceConfig?.keyboard}
                title={t('toolbar.pasteText')}
                onClick={() => {
                  closeAllPopovers();
                }}
              >
                <IconClipboard className={getIconClassName(isPasteTextPanelOpen)} />
                <span>{t('toolbar.pasteText')}</span>
              </Button>
            </PopoverTrigger>
            {/* Dropdown Arrow for Copy Text - stop event propagation */}
            <DropdownMenu
              modal={true}
              open={isCopyTextDropdownOpen}
              onOpenChange={setIsCopyTextDropdownOpen}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="default"
                  className={cn(buttonClassName, 'rounded-l-none border-l-0 px-2 focus:outline-none focus-visible:outline-none focus-visible:ring-0')}
                  disabled={!isChannelReady || !usbDeviceConfig?.keyboard}
                  title={t('toolbar.moreTextActions', { defaultValue: 'More text actions' })}
                  onClick={(e: MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
                  }}
                >
                  <svg
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                className="pointer-events-auto"
                onPointerDown={(e: React.PointerEvent) => {
                  e.stopPropagation();
                }}
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                }}
              >
                <DropdownMenuItem
                  className="pointer-events-auto"
                  onClick={(e: MouseEvent<HTMLDivElement>) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setIsCopyTextDropdownOpen(false);
                    handleOcrClick(e);
                  }}
                  disabled={!isChannelReady}
                >
                  <Type className="mr-2 size-4" />
                  {t('toolbar.copyText', { defaultValue: 'Copy text' })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <PopoverContent
            className={cn(
              popoverContentClassName,
              'max-h-[calc(100dvh-180px)] w-[min(calc(100vw-24px),550px)] overflow-auto bg-(--bg-secondary) sm:w-[550px]'
            )}
            sideOffset={8}
            align="start"
            collisionPadding={12}
            onOpenAutoFocus={e => e.preventDefault()}
          >
            <PasteText
              onSend={() => {
                setIsPasteTextPanelOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>

        {/* Virtual Media */}
        <Popover
          modal={true}
          open={isVirtualMediaOpen}
          onOpenChange={open =>
            openPopoverExclusive(setIsVirtualMediaOpen, open)
          }
        >
          <PopoverTrigger asChild>
            <Button
              variant="default"
              className={buttonClassName}
              disabled={!isChannelReady || !usbDeviceConfig?.mass_storage}
              title={t('toolbar.virtualMedia')}
            >
              <IconCd className={getIconClassName(isVirtualMediaOpen)} />
              <span>{t('toolbar.virtualMedia')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={cn(
              popoverContentClassName,
              virtualMediaDialogOpen && 'invisible pointer-events-none'
            )}
            sideOffset={8}
            align="start"
            onOpenAutoFocus={e => e.preventDefault()}
            {...(virtualMediaDialogOpen ? { inert: true } : {})}
          >
            <VirtualMedia
              onClose={() => setIsVirtualMediaOpen(false)}
              onDialogStateChange={setVirtualMediaDialogOpen}
              rpc={rpc}
              closeInternalDialogsRef={virtualMediaInternalDialogsRef}
            />
          </PopoverContent>
        </Popover>
        {/* Virtual USB Drive   disabled={!isChannelReady} */}
        {fileTransfer && isChannelReady ? (
          <Popover
            modal={true}
            open={isVirtualUsbDriveOpen}
            onOpenChange={open =>
              openPopoverExclusive(setIsVirtualUsbDriveOpen, open)
            }
          >
            <PopoverTrigger asChild>
              <Button
                variant="default"
                className={buttonClassName}
                disabled={!isChannelReady || !usbDeviceConfig?.mass_storage}
                title={t('toolbar.virtualUsbDrive.title')}
              >
                <IconFileTransfer
                  className={getIconClassName(isVirtualMediaOpen)}
                />
                <span>{t('toolbar.virtualUsbDrive.title')}</span>
              </Button>
            </PopoverTrigger>
            {/*  className="bg-[transparent] border-[transparent] shadow-none" */}
            <PopoverContent
              sideOffset={8}
              align="start"
              className="w-[calc(100vw-24px)] bg-transparent border-transparent p-0 shadow-none sm:w-[750px]"
            >
              <VirtualUsbDrive

                onClose={() => setIsVirtualMediaOpen(false)}
                rpc={[send, isChannelReady, sendAsync]}
              />
            </PopoverContent>
          </Popover>
        ) : null}

        {/* Wake on LAN */}
        <Popover
          modal={false}
          open={isWakeOnLanOpen}
          onOpenChange={open => openPopoverExclusive(setIsWakeOnLanOpen, open)}
        >
          <PopoverTrigger asChild>
            <Button
              variant="default"
              className={buttonClassName}
              disabled={!isChannelReady}
              title={t('toolbar.wol')}
            >
              <IconRouter className={getIconClassName(false)} />
              <span>{t('toolbar.wol')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={popoverContentClassName}
            sideOffset={8}
            align="start"
            onOpenAutoFocus={e => e.preventDefault()}
          >
            <WakeOnLAN
              onWake={() => {
                setIsWakeOnLanOpen(false);
              }}
              onClose={() => {}}
            />
          </PopoverContent>
        </Popover>

        {/* Virtual Keyboard */}
        <Button
          variant="default"
          className={buttonClassName}
          onClick={e => handleKeyboardClick(e)}
          disabled={!isChannelReady || !usbDeviceConfig?.keyboard}
          title={keyboardEnabled ? t('keyboard.enable') : t('keyboard.disable')}
        >
          <IconKeyboard className={getIconClassName(visibleVirtualKeyboard)} />
          <span>{t('toolbar.virtualKeyboard')}</span>
        </Button>

      </div>

      {/* Right group */}
      <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
        <MediaDeviceControl
          rpc={[send, isChannelReady, sendAsync]}
          className="flex flex-row gap-[8px]"
        />
        {/*  */}
        <Popover
          modal={false}
          open={isExtensionOpen}
          onOpenChange={open => openPopoverExclusive(setIsExtensionOpen, open)}
        >
          <PopoverTrigger asChild>
            <Button
              variant="default"
              className={buttonClassName}
              disabled={!isChannelReady}
              title={t('toolbar.atxPower')}
            >
              <IconRing className="text-[12px] size-[12px]" />
              <span>{t('toolbar.atxPower')}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className={popoverContentClassName}
            sideOffset={8}
            align="end"
            onOpenAutoFocus={e => e.preventDefault()}
          >
            <Extension rpc={rpc} />
          </PopoverContent>
        </Popover>

        {/* Connection Stats */}
        <Button
          variant="default"
          className={buttonClassName}
          disabled={!isChannelReady}
          onClick={() => {
            closeAllPopovers();
            toggleMain('connectionStats');
          }}
          title={t('toolbar.connectionStats')}
        >
          <IconChartHistogramTwo className="size-[12px]" />
          <span>{t('toolbar.connectionStats')}</span>
        </Button>

        {/* Settings - highlighted */}
        <Button
          variant="default"
          className={buttonClassName}
          disabled={!isChannelReady}
          onClick={handleSettingClick}
          title={t('toolbar.settings')}
        >
          <IconSetting className="size-[12px]" />
          <span>{t('toolbar.settings')}</span>
        </Button>
      </div>
    </div>
  );
});
