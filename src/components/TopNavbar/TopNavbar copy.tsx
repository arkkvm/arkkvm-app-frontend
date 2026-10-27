import {
  IconApi,
  IconDown,
  IconFullScreenFull,
  IconHorizontal,
  IconLessen,
  IconVertical,
  IconWarning,
} from '@/assets/icons';
import { getPeerStateLabel } from '@/i18n/rtc';
import { getUsbStateColor, getUsbStateVisual } from '@/i18n/usb';
import { RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StatusCard } from './StatusCard';
import { LanguageSwitcher } from '../settings/LanguageSwitcher';

import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useLoadingMap } from '@/hooks/useLoading';
import { useAppStore } from '@/stores/';
import type { UserInfo } from '@/stores/slices/userSlice';
import { getStatusColor } from '@/ui/statusColors';
import { env } from '@/utils/env';
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { USBStates } from '@/i18n/usb';
import type { PeerStates } from '@/i18n/rtc';
import BrandLogo from '../ui/brand-logo';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import type { FullScreenData } from '../ControlToolbar';

interface link {
  title: string;
  href: string;
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

// Provider display names for the identity label next to the account email
// (doc 14 §4 /me.identities): same email on different providers must stay
// distinguishable. Unknown providers fall back to their raw id.
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  microsoft: 'Microsoft',
  wechat: 'WeChat',
  apple: 'Apple',
};

interface ITopNavbar {
  links?: link[];
  showLinks?: boolean;
  account?: Pick<UserInfo, 'email' | 'displayName' | 'identities'> | null;
  onLogout?: () => void | Promise<void>;
  showDeviceStatus?: boolean;
  deviceName?: string;
  hostname?: string;
  showLoggedIn?: boolean;
  usbState?: string;
  peerState?: string;
  brandLogoType?: 'icon' | 'full';
  isFullScreen?: boolean;
  onFullScreenClick?: (event: MouseEvent<HTMLElement>, data?: FullScreenData) => void;
  onMinimizeClick?: (event: MouseEvent<HTMLElement>, data?: FullScreenData) => void;
  onReconnect?: (countdown?: number) => void;
}

export default function TopNavbar({
  links = [],
  showLinks = true,
  account,
  onLogout,
  showDeviceStatus,
  deviceName = 'ArkKVM Device',
  hostname,
  showLoggedIn,
  usbState = 'disconnected',
  peerState = 'disconnected',
  brandLogoType = 'full',
  isFullScreen = false,
  onFullScreenClick,
  onMinimizeClick,
  onReconnect,
}: ITopNavbar) {
  const controlLayoutMode = useAppStore(s => s.ui.controlLayoutMode);
  const setControlLayoutMode = useAppStore(s => s.ui.setControlLayoutMode);

  const { t, i18n } = useTranslation('common');
  const currentLang = (i18n.resolvedLanguage ?? i18n.language) as 'en' | 'zh';
  // USB state
  const { label: usbLabel } = getUsbStateVisual(usbState as USBStates, currentLang);
  const usbColor = getUsbStateColor(usbState as USBStates);
  // Device connection (Peer) state
  const peerColor = getStatusColor('rtc.peer', peerState);
  const [, isChannelReady, sendAsync] = useJsonRpc();
  const peerLabel = getPeerStateLabel(peerState as PeerStates, currentLang);
  const getUserInfo = useAppStore(s => s.getUserInfo);
  const logout = useAppStore(s => s.logout);
  const storedUserData = useAppStore(s => s.userInfo);
  const userData = account === undefined ? storedUserData : account;
  const identityLabel = (userData?.identities ?? [])
    .map(i => PROVIDER_LABELS[i.provider] ?? i.provider)
    .join(' / ');
  const accountLabel =
    userData?.email?.trim() ||
    userData?.displayName?.trim() ||
    userData?.identities?.find(identity => identity.email?.trim())?.email?.trim() ||
    userData?.identities?.find(identity => identity.displayName?.trim())?.displayName?.trim() ||
    '';
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const { isLoading, startLoading, stopLoading } = useLoadingMap(['reboot']);
  useEffect(() => {
    if (!showLoggedIn || account !== undefined) return;

    getUserInfo();

    return () => {};
  }, [showLoggedIn, getUserInfo, account]);
  const logoutHandle = useCallback(async () => {
    if (onLogout) await onLogout();
    else await logout();
  }, [logout, onLogout]);
  const rebootDevice = useCallback(async () => {
    if (!isChannelReady) return;
    startLoading('reboot');
    setIsPopoverOpen(false);
    void sendAsync(
      {
        method: 'reboot',
        params: { force: false },
      },
      { timeout: 1000 }
    );
    window.setTimeout(() => {
      onReconnect?.(25);
    }, 0);
    // Stop button loading after 25 seconds
    setTimeout(() => {
      stopLoading('reboot');
    }, 25000);
  }, [isChannelReady, sendAsync, onReconnect, startLoading, stopLoading]);
  // Fullscreen event
  const handleFullScreenClick = (event: MouseEvent<HTMLElement>) => {
    if (isChannelReady) {
      onFullScreenClick?.(event);
    }
  };
  // Exit fullscreen event
  const handleMinimizeClick = (event: MouseEvent<HTMLElement>) => {
    if (isChannelReady) {
      onMinimizeClick?.(event);
    }
  };
  return (
    <div className="flex h-[52px] flex-row justify-between border-b border-(--border-color) bg-secondary-bg px-2 py-2 sm:h-[60px] sm:px-[18px] sm:py-[10px]">
      <div className="flex items-center">
        <BrandLogo type={brandLogoType} size={24} />

        {showLinks && env.target === 'cloud' && (
          <div className="flex-1 flex flex-row items-center gap-[15px] ml-[24px]">
            {links.map(({ title, href, Icon }, i) => {
              return (
                <Link key={i} to={href}>
                  <Button size="lg">
                    <span className="inline-block mr-[8px]">
                      <Icon />
                    </span>
                    <span>{title}</span>
                  </Button>
                </Link>
              );
            })}
          </div>
        )}
        {hostname && (
          <span className="ml-2 max-w-[90px] truncate text-[16px] sm:ml-[16px] sm:max-w-[120px] sm:text-[18px]">
            {hostname}
          </span>
        )}
      </div>
      <div className="flex items-center">
        {showDeviceStatus && (
          <div className="flex flex-row items-center gap-[6px] sm:gap-[12px]">
            <StatusCard
              title={deviceName || ''}
              statusLabel={peerLabel || ''}
              statusColor={peerColor}
              StatusIcon={IconApi}
              className="w-auto"
              slot={
                <Popover modal={false} open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      size="xs"
                      variant="default"
                      className="w-[66px] text-[10px] font-light ml-[8px] rounded-[4px]"
                      disabled={isLoading('reboot')}
                      loading={isLoading('reboot')}
                    >
                      {!isLoading('reboot') && (
                        <>
                          <RotateCcw className="size-[12px] text-text" />
                          <span className="hidden sm:inline">{t('reboot.button')}</span>
                        </>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[380px] mr-[-10px]"
                    sideOffset={8}
                    align="end"
                    onOpenAutoFocus={e => e.preventDefault()}
                  >
                    <ul className="text-sm gap-[4px] flex flex-col">
                      <li className="flex items-center gap-[8px] text-base">
                        <IconWarning className="size-[16px]" /> {t('reboot.title')}
                      </li>
                      {(t('reboot.desc', { returnObjects: true }) as string[]).map(
                        (line, index) => (
                          <li key={index}>{line}</li>
                        )
                      )}
                      <li className="flex justify-end mt-[16px]">
                        <Button
                          variant="primary"
                          size="xs"
                          status="danger"
                          className="px-[12px]"
                          onClick={rebootDevice}
                          disabled={isLoading('reboot')}
                          loading={isLoading('reboot')}
                        >
                          {t('reboot.confirm')}
                        </Button>
                      </li>
                    </ul>
                  </PopoverContent>
                </Popover>
              }
            />
            <StatusCard
              title="USB"
              statusLabel={usbLabel || ''}
              statusColor={usbColor}
              StatusIcon={IconApi}
            />

            {controlLayoutMode === 'vertical' ? (
              <Button
                size="lg"
                className="w-[36px]"
                onClick={() => setControlLayoutMode('horizontal')}
              >
                <IconHorizontal className="size-[12px] cursor-pointer" />
              </Button>
            ) : (
              <Button
                size="lg"
                className="w-[36px]"
                onClick={() => setControlLayoutMode('vertical')}
              >
                <IconVertical className="size-[12px] cursor-pointer" />
              </Button>
            )}

            {isFullScreen ? (
              <Button size="lg" className="w-[36px]" onClick={handleMinimizeClick}>
                <IconLessen className="size-[12px]" />
              </Button>
            ) : (
              <Button size="lg" className="w-[36px]" onClick={handleFullScreenClick}>
                <IconFullScreenFull className="size-[12px]" />
              </Button>
            )}
          </div>
        )}

        {showLoggedIn && (
          <div className="min-auto pl-[24px] flex items-center justify-start">
            {(env.target === 'cloud' || account !== undefined) && (
              <>
                <LanguageSwitcher bordered={false} showIcon />
                <span
                  aria-hidden="true"
                  className="mx-3 h-4 shrink-0 border-l border-(--border-color)"
                />
              </>
            )}
            <div className="flex h-[32px] flex-row">
              {/* <img
                src={picture}
                className="w-[32px] h-[32px] rounded-[50%] object-cover border border-[var(--border-color)]"
              /> */}
              {accountLabel ? (
                <div className="flex items-center min-w-0 max-w-[320px] pl-[10px] gap-[6px]">
                  <span className="text-[16px] leading-[32px] truncate">{accountLabel}</span>
                  {identityLabel ? (
                    <span className="shrink-0 text-[12px] leading-[32px] text-[var(--inactive-text-color)]">
                      {identityLabel}
                    </span>
                  ) : null}
                </div>
              ) : (
                <></>
              )}

              {(account === undefined || onLogout) && (
                <div className="flex w-[20px] items-center justify-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconDown></IconDown>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={logoutHandle}>
                        {t('login.logout')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
