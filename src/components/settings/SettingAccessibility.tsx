import { request } from '@/api';
import type { kvmLocalDevice } from '@/api/types';
import type { TLSMode, TLSStateRequest } from '@/api/rpc/methods';
import { Loading, SettingLocalAuth } from '@/components';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useLoadingMap } from '@/hooks/useLoading';
import { useRestartDialog } from '@/hooks/useRestartDialog';
import { useSettingsActions } from '@/stores/devicesStore';
import { env } from '@/utils/env';
import { createLogger } from '@/utils/logger';
import { normalizeCloudOrigin } from '@/utils/security';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { Input } from '../ui/input';
import { Select, SelectSeparator } from '../ui/select';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import SettingBlock from './SettingBlock';
import SettingNetbird from './SettingNetbird';
import SettingPageContainer from './SettingPageContainer';
import type { TailscaleConnectionState } from '@/api/rpc/tailscale';
import {
  getConnectionState,
  getTailscaleIP,
  getTailscaleHostname,
  getTailnetName,
  getUserEmail,
} from '@/api/rpc/tailscale';

const logger = createLogger('SettingAccessibility');

export default function SettingAccessibility() {
  const { t } = useTranslation(['settings']);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isAdopted, setAdopted] = useState(false);
  const [cloudApiUrl, setCloudApiUrl] = useState('');
  const [cloudAppUrl, setCloudAppUrl] = useState('');
  const [cloudApiUrlError, setCloudApiUrlError] = useState('');
  const [cloudAppUrlError, setCloudAppUrlError] = useState('');
  const [send, isChannelReady, sendAsync] = useJsonRpc();
  const [tlsMode, setTlsMode] = useState<TLSMode>('disabled');
  const [tlsCert, setTlsCert] = useState<string>('');
  const [tlsKey, setTlsKey] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('arkkvm');
  const [loading, setLoading] = useState(false);
  const [localAuth, setLocalAuth] = useState(false);
  const [localAuthAction, setLocalAuthAction] = useState<
    'initPwd' | 'changePwd' | 'removePwd' | undefined
  >(undefined);
  const [authMode, setAauthMode] = useState<string>();
  const [deregisterLoading, setDeregisterLoading] = useState(false);

  // Tailscale states
  const [tailscaleEnabled, setTailscaleEnabled] = useState(false);

  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleConnectionState>('disconnected');
  const [tailscaleInfo, setTailscaleInfo] = useState<{
    ip: string;
    hostname: string;
    tailnetName: string;
    userEmail: string;
  } | null>(null);
  const [tailscaleLoginUrl, setTailscaleLoginUrl] = useState<string>('');

  const { showRestartDialog } = useRestartDialog();
  const { setNestedDeviceSetting } = useSettingsActions();
  const navigate = useNavigate();
  const { isLoading, start, stop } = useLoadingMap([
    'switchTailscale',
    'registerTailscale',
    'getTailscaleState',
  ]);
  useEffect(() => {
    let cancelled = false;
    if (!isChannelReady) return;
    void (async () => {
      try {
        const [cloudState, cloudDeviceId] = await Promise.all([
          sendAsync({ method: 'getCloudState' }, { resultOnly: true }),
          sendAsync({ method: 'getDeviceID' }, { resultOnly: true }),
        ]);
        await fetchTailscaleState();

        if (cancelled) return;
        if (cloudDeviceId) {
          setDeviceId(cloudDeviceId);
        }

        if (cloudState) {
          setAdopted(cloudState.connected);
          setCloudApiUrl(cloudState.url);
          setCloudAppUrl(cloudState.appUrl);
          if (
            (cloudState.url === env.officialCloudApiUrl &&
              cloudState.appUrl === env.officialCloudAppUrl) ||
            !cloudState.connected
          ) {
            setSelectedProvider('arkkvm');
          } else {
            setSelectedProvider('custom');
          }
        }
      } catch (error) {
        logger.error('Failed to load cloud state', error);
        toast.error('Failed to load cloud state');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isChannelReady, sendAsync]);

  useEffect(() => {
    if (!isChannelReady) return;
    void (async () => {
      const tlsState = await sendAsync(
        { method: 'getTLSState' },
        { timeout: 10000, resultOnly: true, showUnhandledErrorToast: true }
      );
      if (!tlsState) return;
      if (!tlsState.mode) {
        setTlsMode('disabled');
      } else {
        setTlsMode(tlsState.mode);
      }
      if (tlsState.certificate) setTlsCert(tlsState.certificate);
      // if (tlsState.privateKey) setTlsKey(tlsState.privateKey);
    })();
  }, [isChannelReady, sendAsync]);

  useEffect(() => {
    const fetchAuthMode = async () => {
      const { success, data: deviceData } = await request.get<kvmLocalDevice>('/device');
      if (!success) return;
      logger.info('Device auth mode loaded', { authMode: deviceData?.authMode });
      setDeviceId(deviceData?.deviceId);
      setAauthMode(deviceData?.authMode);
      setNestedDeviceSetting(prev => ({
        ...prev,
        authMode: deviceData?.authMode,
      }));
    };
    if (env.target === 'device') {
      fetchAuthMode();
    }
  }, [localAuth, setNestedDeviceSetting]);

  const updateTlsState = useCallback(
    (mode: TLSMode, cert?: string, key?: string) => {
      void (async () => {
        const state: TLSStateRequest = { mode };
        if (cert && key) {
          state.certificate = cert;
          state.privateKey = key;
        }
        logger.info('Updating TLS state', { mode: state.mode });
        const resp = await sendAsync(
          { method: 'setTLSState', params: { state: state } },
          { timeout: 10000 }
        );
        if ('error' in resp) {
          toast.error(`Failed to update TLS settings: ${resp.error.data || 'Unknown error'}`);
          return;
        }
        showRestartDialog();
        toast.success('TLS settings updated successfully');
      })();
    },
    [sendAsync]
  );

  const handleProviderChange = (value: string) => {
    setSelectedProvider(value);
    if (value === 'arkkvm') {
      setCloudApiUrl(env.officialCloudApiUrl);
      setCloudAppUrl(env.officialCloudAppUrl);
      setCloudApiUrlError('');
      setCloudAppUrlError('');
    } else {
      if (cloudApiUrl || cloudAppUrl) return;
      setCloudApiUrl('');
      setCloudAppUrl('');
      setCloudApiUrlError('');
      setCloudAppUrlError('');
    }
  };

  const validateCloudUrl = (url: string, type: 'api' | 'app'): string => {
    if (!url) return '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return type === 'api'
          ? t('settings:accessibility.cloudUrls.invalidApiUrl')
          : t('settings:accessibility.cloudUrls.invalidAppUrl');
      }
      return '';
    } catch {
      return type === 'api'
        ? t('settings:accessibility.cloudUrls.invalidApiUrl')
        : t('settings:accessibility.cloudUrls.invalidAppUrl');
    }
  };

  const handleTlsModeChange = (value: string) => {
    const mode = value as TLSMode;
    setTlsMode(mode);
    if (mode !== 'custom') {
      updateTlsState(mode);
    }
  };
  const handleTlsCertChange = (value: string) => {
    setTlsCert(value);
  };
  const handleTlsKeyChange = (value: string) => {
    setTlsKey(value);
  };
  const handleCustomTlsUpdate = () => {
    updateTlsState(tlsMode, tlsCert, tlsKey);
  };
  const onCloudAdoptClick = useCallback(
    (cloudApiUrl: string, cloudAppUrl: string) => {
      if (!deviceId) {
        toast.error('No device ID available');
        return;
      }
      setLoading(true);
      const safeAppOrigin = normalizeCloudOrigin(cloudAppUrl);
      if (!safeAppOrigin) {
        toast.error('Invalid cloud app URL');
        setLoading(false);
        return;
      }
      send({
        method: 'setCloudUrl',
        params: { apiUrl: cloudApiUrl, appUrl: cloudAppUrl },
        onResponse: resp => {
          setLoading(false);
          if ('error' in resp) {
            toast.error(`Failed to update cloud URL: ${resp.error.data || 'Unknown error'}`);
            return;
          }

          const returnTo = new URL(window.location.href);
          returnTo.pathname = '/ad-login';
          returnTo.search = '';
          returnTo.hash = '';
          window.location.href =
            safeAppOrigin +
            '/login?deviceId=' +
            deviceId +
            `&returnTo=${returnTo.toString()}&cloudApiUrl=${cloudApiUrl}`;
        },
      });
    },
    [deviceId, send]
  );
  const deregisterDevice = () => {
    setDeregisterLoading(true);
    send({
      method: 'deregisterDevice',
      onResponse: resp => {
        if ('error' in resp) {
          toast.error(`Failed to deregister device: ${resp.error?.data || 'Unknown error'}`);
          return;
        }
        toast.success('Device deregistered');
        setDeregisterLoading(false);
        if (env.target === 'cloud') {
          navigate('/devices/list');
        } else {
          send({
            method: 'getCloudState',
            onResponse: resp => {
              if ('error' in resp) {
                toast.error(`Failed to get cloud state: ${resp.error?.data || 'Unknown error'}`);
                return;
              }
              setAdopted(resp.result?.connected);
            },
          });
        }
      },
    });
  };

  // Tailscale handlers
  const fetchTailscaleState = useCallback(async () => {
    start('getTailscaleState');

    const state = await sendAsync(
      { method: 'getTailscaleState' },
      { resultOnly: true, showUnhandledErrorToast: true }
    );

    stop('getTailscaleState');

    if (!state) return null;

    const { status } = state;
    const loginServer = state.loginServer || status?.AuthURL;
    setTailscaleEnabled(state.enabled || false);

    // Safely get connectionState using utility
    const connectionState = getConnectionState(state);
    setTailscaleStatus(connectionState);
    // Safely get Tailscale info (supports camelCase and PascalCase fields)
    const tailscaleIp = getTailscaleIP(status);
    const hostname = getTailscaleHostname(status);
    const tailnetName = getTailnetName(status);
    const userEmail = getUserEmail(status);
    if (tailscaleIp) {
      setTailscaleInfo({ ip: tailscaleIp, hostname, tailnetName, userEmail });
    } else {
      setTailscaleInfo(null);
    }

    // Get authUrl from status.AuthURL
    if (loginServer) {
      setTailscaleLoginUrl(loginServer);
    } else {
      setTailscaleLoginUrl('');
    }

    return state;
  }, [sendAsync, start, stop]);

  // Refresh state when user returns from external login (only when disconnected)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && tailscaleStatus !== 'connected') {
        logger.info('Page became visible, refreshing Tailscale state');
        void fetchTailscaleState();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchTailscaleState, tailscaleStatus]);

  const handleTailscaleToggle = useCallback(
    async (isEnabled: boolean) => {
      start('switchTailscale');
      if (isEnabled) setTailscaleStatus('connecting');

      const switchResponse = await sendAsync({
        method: 'switchTailscale',
        params: { enabled: isEnabled },
      });

      stop('switchTailscale');
      if (!switchResponse?.success) return;

      setTailscaleEnabled(isEnabled);

      if (isEnabled) {
        // Wait a moment for Tailscale service to start
        await new Promise(resolve => setTimeout(resolve, 6000));
        const tailscaleState = await fetchTailscaleState();
        if (tailscaleState?.connectionState !== 'connected') {
          void generateNewTailscaleLink();
        }
      }
    },
    [sendAsync, start, stop, fetchTailscaleState]
  );

  const openTailscaleLogin = useCallback(() => {
    if (tailscaleLoginUrl) {
      window.open(tailscaleLoginUrl, '_blank');
    }
  }, [tailscaleLoginUrl]);

  const generateNewTailscaleLink = useCallback(
    async (forceReauth = false) => {
      setTailscaleInfo(null);
      start('registerTailscale');
      setTailscaleStatus('connecting');

      const method = forceReauth ? 'registerTailscaleForce' : 'registerTailscale';
      const resp = await sendAsync({ method }, { showUnhandledErrorToast: true });
      stop('registerTailscale');
      setTailscaleStatus('loggedOut');
      if (!resp.success) return;
      const authUrl = resp.result.authUrl || resp.result.auth_url;

      if (authUrl) {
        setTailscaleLoginUrl(authUrl);
        window.open(authUrl, '_blank');
        toast.success('New login link generated');
      } else {
        fetchTailscaleState();
      }
    },
    [sendAsync, start, stop, fetchTailscaleState, setTailscaleStatus]
  );

  const stopKeyEventPropagation = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Prevent event bubbling to avoid global hotkey/KVM capture
    e.stopPropagation();
  };

  // Local auth
  const handleLocalAuth = (action: string) => {
    setLocalAuth(true);
    setLocalAuthAction(action as 'initPwd' | 'changePwd' | 'removePwd');
  };
  const handleLocalAuthClose = () => {
    setLocalAuth(false);
    setLocalAuthAction(undefined);
  };

  const handleAuthModeChange = useCallback(
    (mode: 'password' | 'no') => {
      setAauthMode(mode);
      setNestedDeviceSetting(prev => ({
        ...prev,
        authMode: mode,
      }));
    },
    [setNestedDeviceSetting]
  );

  const settingLoaclAuthComponent = useMemo(() => {
    return (
      <SettingLocalAuth
        onClose={handleLocalAuthClose}
        localAuthAction={localAuthAction}
        onAuthModeChange={handleAuthModeChange}
      ></SettingLocalAuth>
    );
  }, [localAuth, localAuthAction, handleAuthModeChange]);

  return (
    <SettingPageContainer
      title={t('settings:pages.accessibility.title')}
      description={t('settings:pages.accessibility.description')}
    >
      {localAuth ? (
        settingLoaclAuthComponent
      ) : (
        <div>
          <SettingBlock
            title={t('settings:accessibility.local.title')}
            content={t('settings:accessibility.local.desc')}
          ></SettingBlock>
          <SettingBlock
            title={t('settings:accessibility.httpsMode.title')}
            content={t('settings:accessibility.httpsMode.desc')}
          >
            <SettingBlock.Right>
              <Select
                value={tlsMode}
                size="xs"
                onChange={handleTlsModeChange}
                placeholder={t(
                  'settings:hardware.displayBrightness.placeholder',
                  'Select brightness'
                )}
                options={[
                  {
                    value: 'disabled',
                    label: t('settings:accessibility.httpsMode.disabled'),
                  },
                  {
                    value: 'self-signed',
                    label: t('settings:accessibility.httpsMode.selfSigned'),
                  },
                  {
                    value: 'custom',
                    label: t('settings:accessibility.httpsMode.custom'),
                  },
                ]}
                disabled={!isChannelReady}
              />
            </SettingBlock.Right>
            {tlsMode === 'custom' && (
              <SettingBlock.Bottom className="flex flex-col gap-5 pl-[24px]">
                <div>
                  <h4 className="text-sm font-medium text-text mb-1">
                    {t('settings:accessibility.tlsCertificate.title')}
                  </h4>
                  <p className="text-sm text-text-muted mb-4">
                    {t('settings:accessibility.tlsCertificate.desc')}
                  </p>
                  <Textarea
                    value={tlsCert}
                    labelPosition="top"
                    label={t('settings:accessibility.tlsCertificate.certLabel')}
                    // description={t('settings:accessibility.tlsCertificate.desc')}
                    labelClassName="text-text text-xs"
                    className="text-xs h-24 font-normal"
                    rows={3}
                    placeholder={t('settings:accessibility.tlsCertificate.certPlaceholder')}
                    onChange={e => handleTlsCertChange(e.target.value)}
                    onKeyDown={stopKeyEventPropagation}
                  />
                  <Textarea
                    value={tlsKey}
                    labelPosition="top"
                    label={t('settings:accessibility.tlsCertificate.keyLabel')}
                    labelClassName="text-text text-xs mt-3"
                    className="text-xs h-24"
                    description={t('settings:accessibility.tlsCertificate.keyDescription')}
                    rows={3}
                    placeholder={t('settings:accessibility.tlsCertificate.keyPlaceholder')}
                    onChange={e => handleTlsKeyChange(e.target.value)}
                    onKeyDown={stopKeyEventPropagation}
                  ></Textarea>
                  <Button
                    className="mt-4"
                    variant="primary"
                    size="xs"
                    onClick={handleCustomTlsUpdate}
                    disabled={!tlsKey}
                  >
                    {t('settings:accessibility.tlsCertificate.updateButton')}
                  </Button>
                </div>
              </SettingBlock.Bottom>
            )}
          </SettingBlock>

          <SettingBlock
            title={t('settings:accessibility.authMode.title')}
            content={`${t('settings:accessibility.authMode.currentMode')} ${authMode === 'password' ? t('settings:accessibility.authMode.passwordProtected') : t('settings:accessibility.authMode.noPassword')}`}
          >
            <SettingBlock.Right>
              {authMode === 'password' && (
                <Button
                  variant="primary"
                  size="xs"
                  onClick={() => {
                    handleLocalAuth('removePwd');
                  }}
                >
                  {t('settings:accessibility.authMode.disableButton')}
                </Button>
              )}
              {authMode !== 'password' && (
                <Button
                  variant="primary"
                  size="xs"
                  onClick={() => {
                    handleLocalAuth('initPwd');
                  }}
                >
                  {t('settings:accessibility.authMode.enableButton')}
                </Button>
              )}
            </SettingBlock.Right>
          </SettingBlock>
          {env.target === 'device' && authMode === 'password' && (
            <SettingBlock
              title={t('settings:accessibility.changePassword.title')}
              content={t('settings:accessibility.changePassword.desc')}
            >
              <SettingBlock.Right>
                <Button
                  variant="primary"
                  size="xs"
                  onClick={() => {
                    handleLocalAuth('changePwd');
                  }}
                >
                  {t('settings:accessibility.changePassword.button')}
                </Button>
              </SettingBlock.Right>
            </SettingBlock>
          )}
          <SelectSeparator className="mb-6" />

          <SettingBlock
            title={t('settings:accessibility.remote.title')}
            content={t('settings:accessibility.remote.desc')}
          >
            <SettingBlock.Right>
              <Select
                value={selectedProvider}
                size="xs"
                onChange={handleProviderChange}
                placeholder={t(
                  'settings:hardware.displayBrightness.placeholder',
                  'Select brightness'
                )}
                options={[
                  {
                    value: 'arkkvm',
                    label: t('settings:accessibility.cloudProvider.arkkvm'),
                  },
                  {
                    value: 'custom',
                    label: t('settings:accessibility.cloudProvider.custom'),
                  },
                ]}
                disabled={!isChannelReady || isAdopted}
              />
            </SettingBlock.Right>
            <SettingBlock.Bottom className="pl-[24px]">
              {selectedProvider === 'arkkvm' ? (
                <div className="flex items-start gap-3 p-4 bg-secondary-background border border-(--border-color) rounded-lg mt-6">
                  <div className="flex-shrink-0 w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center  ">
                    <svg
                      className="w-5 h-5 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-sm font-medium text-text mb-2">
                      {t('settings:accessibility.cloudSecurity.title')}
                    </h3>
                    <ul className="space-y-1 text-sm text-inactive-text">
                      <li>• {t('settings:accessibility.cloudSecurity.feature1')}</li>
                      <li>• {t('settings:accessibility.cloudSecurity.feature2')}</li>
                      <li>• {t('settings:accessibility.cloudSecurity.feature3')}</li>
                      <li>• {t('settings:accessibility.cloudSecurity.feature4')}</li>
                    </ul>
                    {/* <p className="text-sm text-inactive-text mt-3">
                        {t(
                          'settings:accessibility.cloudSecurity.openSourceText'
                        )}{' '}
                        <a
                          href="https://github.com"
                          className="text-blue-500 hover:text-blue-600 underline"
                        >
                          GitHub
                        </a>
                        .
                      </p>
                      <button className="mt-3 px-3 py-1.5 text-sm border border-(--border-color) rounded-md hover:bg-[var(--hover-background)] transition-colors">
                        {t(
                          'settings:accessibility.cloudSecurity.learnMoreButton'
                        )}
                      </button> */}
                  </div>
                </div>
              ) : (
                <div className="text-text">
                  <Input
                    label={t('settings:accessibility.cloudUrls.apiLabel')}
                    labelPosition="top"
                    labelSize={12}
                    labelClassName="text-text text-xs mt-3"
                    placeholder={t('settings:accessibility.cloudUrls.apiPlaceholder')}
                    value={cloudApiUrl}
                    size="xs"
                    onChange={e => {
                      const value = e.target.value;
                      setCloudApiUrl(value);
                      setCloudApiUrlError(validateCloudUrl(value, 'api'));
                    }}
                    aria-invalid={!!cloudApiUrlError}
                    className={cloudApiUrlError ? 'border-destructive' : ''}
                    disabled={isAdopted}
                  ></Input>
                  <Input
                    label={t('settings:accessibility.cloudUrls.appLabel')}
                    labelPosition="top"
                    labelSize={12}
                    labelClassName="text-text text-xs mt-3"
                    placeholder={t('settings:accessibility.cloudUrls.appPlaceholder')}
                    value={cloudAppUrl}
                    size="xs"
                    disabled={isAdopted}
                    onChange={e => {
                      const value = e.target.value;
                      setCloudAppUrl(value);
                      setCloudAppUrlError(validateCloudUrl(value, 'app'));
                    }}
                    aria-invalid={!!cloudAppUrlError}
                    className={cloudAppUrlError ? 'border-destructive' : ''}
                  ></Input>
                </div>
              )}

              <div className="flex justify-end mt-5">
                {!isAdopted ? (
                  <Button
                    onClick={() => onCloudAdoptClick(cloudApiUrl, cloudAppUrl)}
                    disabled={loading || !isChannelReady}
                    variant="primary"
                    size="xs"
                  >
                    {loading
                      ? t('settings:accessibility.cloudButtons.loading')
                      : t('settings:accessibility.cloudButtons.adopt')}
                  </Button>
                ) : (
                  <Button
                    loading={deregisterLoading}
                    onClick={() => deregisterDevice()}
                    disabled={loading || !isChannelReady}
                    variant="primary"
                    size="xs"
                  >
                    {loading
                      ? t('settings:accessibility.cloudButtons.loading')
                      : t('settings:accessibility.cloudButtons.deregister')}
                  </Button>
                )}
              </div>
            </SettingBlock.Bottom>
          </SettingBlock>

          {/* Tailscale */}
          <SettingBlock
            title={t('settings:accessibility.privateNetwork.title')}
            content={t('settings:accessibility.privateNetwork.desc')}
          >
            <SettingBlock.Bottom className="pl-6">
              <SettingBlock
                title={t('settings:accessibility.tailscale.title')}
                content={t('settings:accessibility.tailscale.desc')}
              >
                <SettingBlock.Right>
                  <Switch
                    checked={tailscaleEnabled}
                    onCheckedChange={handleTailscaleToggle}
                    disabled={isLoading('switchTailscale')}
                  />
                </SettingBlock.Right>

                {tailscaleEnabled && (
                  <SettingBlock.Bottom>
                    <div className="flex flex-col gap-4 p-6  rounded-lg border border-(--border-color)">
                      {/* Authentication State (needs_auth or logged_out) */}
                      {tailscaleStatus !== 'connected' && tailscaleStatus !== 'connecting' && (
                        <div className="flex flex-col gap-4">
                          <p className="text-sm text-text-secondary">
                            {t('settings:accessibility.tailscale.actions.authHint')}
                          </p>
                          <div className="flex items-center gap-3">
                            <Button
                              variant="primary"
                              size="xs"
                              onClick={openTailscaleLogin}
                              disabled={!tailscaleLoginUrl || isLoading('registerTailscale')}
                              loading={isLoading('registerTailscale')}
                            >
                              {t('settings:accessibility.tailscale.actions.openLogin')}
                            </Button>
                          </div>
                          <p className="text-sm text-text-muted">
                            {t('settings:accessibility.tailscale.actions.authExpiredBefore')}
                            <button
                              onClick={() => generateNewTailscaleLink()}
                              disabled={isLoading('registerTailscale')}
                              className="text-blue-500 hover:text-blue-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer p-0"
                            >
                              {t('settings:accessibility.tailscale.actions.generateNewLink')}
                            </button>
                            {t('settings:accessibility.tailscale.actions.authExpiredAfter')}
                          </p>
                        </div>
                      )}

                      {/* Connecting State */}
                      {tailscaleStatus === 'connecting' && (
                        <div className="flex flex-col items-center justify-center py-8 gap-3">
                          <Loading type="spinner" size="md" color="blue" />
                          <p className="text-sm text-text-muted">
                            {t('settings:accessibility.tailscale.status.connecting')}
                          </p>
                        </div>
                      )}

                      {/* Connected State */}
                      {tailscaleStatus === 'connected' && tailscaleInfo && (
                        <div className="flex flex-col">
                          {/* Tailnet Section */}
                          <div className="flex justify-between items-center pb-4 border-b border-(--border-color)">
                            <div className="flex flex-col">
                              <span className="text-sm text-text-muted">Tailnet</span>
                              <span className="text-sm font-medium text-text">
                                {tailscaleInfo.userEmail}
                              </span>
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() => generateNewTailscaleLink(true)}
                              disabled={isLoading('registerTailscale')}
                              loading={isLoading('registerTailscale')}
                            >
                              Change
                            </Button>
                          </div>
                          <div className="flex justify-between items-center py-4 border-b border-(--border-color)">
                            <span className="text-sm text-text-muted">
                              {t('settings:accessibility.tailscale.fields.status')}
                            </span>
                            <span className="text-sm font-medium text-text">
                              {t('settings:accessibility.tailscale.status.connected')}
                            </span>
                          </div>
                          <div className="flex justify-between items-center py-4 border-b border-(--border-color)">
                            <span className="text-sm text-text-muted">
                              {t('settings:accessibility.tailscale.fields.tailscaleIp')}
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text select-text">
                                {tailscaleInfo.ip}
                              </span>
                              <CopyButton
                                text={tailscaleInfo.ip}
                                label="Tailscale IP"
                                variant="ghost"
                                size="xs"
                              />
                            </div>
                          </div>
                          <div className="flex justify-between items-center pt-4">
                            <span className="text-sm text-text-muted">MagicDNS</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text select-text">
                                {tailscaleInfo.hostname}
                              </span>
                              <CopyButton
                                text={tailscaleInfo.hostname}
                                label="MagicDNS"
                                variant="ghost"
                                size="xs"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </SettingBlock.Bottom>
                )}
              </SettingBlock>

              {/* NetBird (self-hostable WireGuard mesh) */}
              <SettingNetbird tailscaleEnabled={tailscaleEnabled} />
            </SettingBlock.Bottom>
          </SettingBlock>
        </div>
      )}
      {/* Private Network Section Header */}
    </SettingPageContainer>
  );
}
