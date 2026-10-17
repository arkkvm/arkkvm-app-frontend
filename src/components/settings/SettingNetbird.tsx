import type {
  NetbirdConnectionState,
  NetbirdStateResponse,
  RegisterNetbirdResponse,
} from '@/api/rpc/netbird';
import {
  NETBIRD_CLOUD_MANAGEMENT_URL,
  isValidManagementUrl,
  isValidPeerHostname,
  netbirdErrorMessage,
} from '@/api/rpc/netbird';
import { Loading } from '@/components';
import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useLoadingMap } from '@/hooks/useLoading';
import { createLogger } from '@/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import SettingBlock from './SettingBlock';

const logger = createLogger('SettingNetbird');

/** How often to poll while waiting for SSO login / the tunnel to come up. */
const POLL_INTERVAL_MS = 5000;
/** Stop polling after the device-flow login window (matches firmware detach timeout). */
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type ServerMode = 'cloud' | 'selfHosted';

interface SettingNetbirdProps {
  /** Used to warn about the shared 100.64.0.0/10 CGNAT range. */
  tailscaleEnabled?: boolean;
}

/**
 * NetBird (self-hostable WireGuard mesh VPN) settings, shown in the
 * "Private Network" section next to Tailscale. Hidden when the system image
 * does not ship NetBird (`available: false`).
 */
export default function SettingNetbird({ tailscaleEnabled = false }: SettingNetbirdProps) {
  const { t } = useTranslation(['settings']);
  const [, isChannelReady, sendAsync] = useJsonRpc();
  const { isLoading, start, stop } = useLoadingMap([
    'getNetbirdState',
    'switchNetbird',
    'registerNetbird',
  ]);

  const [state, setState] = useState<NetbirdStateResponse | null>(null);
  const [connectionState, setConnectionState] = useState<NetbirdConnectionState>('unknown');

  // Settings form (persisted on the device via switchNetbird)
  const [serverMode, setServerMode] = useState<ServerMode>('cloud');
  const [managementUrl, setManagementUrl] = useState('');
  const [hostname, setHostname] = useState('');

  // Registration
  const [setupKey, setSetupKey] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [userCode, setUserCode] = useState('');
  const [reauth, setReauth] = useState(false);
  const [awaitingAuthSince, setAwaitingAuthSince] = useState<number | null>(null);

  const formInitialized = useRef(false);

  const fetchState = useCallback(async () => {
    start('getNetbirdState');
    const next = await sendAsync({ method: 'getNetbirdState' }, { resultOnly: true });
    stop('getNetbirdState');
    if (!next) return null;

    setState(next);
    setConnectionState(next.enabled ? (next.connectionState ?? 'unknown') : 'unknown');

    // Only seed the form once so polling does not overwrite user edits.
    if (!formInitialized.current) {
      formInitialized.current = true;
      setServerMode(next.managementUrl ? 'selfHosted' : 'cloud');
      setManagementUrl(next.managementUrl ?? '');
      setHostname(next.hostname ?? '');
    }

    if (next.connectionState === 'connected') {
      setAwaitingAuthSince(null);
      setLoginUrl('');
      setUserCode('');
      setReauth(false);
    }
    return next;
  }, [sendAsync, start, stop]);

  useEffect(() => {
    if (!isChannelReady) return;
    void fetchState();
  }, [isChannelReady, fetchState]);

  // Poll while the user completes SSO in another tab.
  useEffect(() => {
    if (awaitingAuthSince === null) return;
    const id = window.setInterval(() => {
      if (Date.now() - awaitingAuthSince > POLL_TIMEOUT_MS) {
        setAwaitingAuthSince(null);
        return;
      }
      void fetchState();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [awaitingAuthSince, fetchState]);

  // Refresh when returning from the login tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && state?.enabled && connectionState !== 'connected') {
        logger.info('Page became visible, refreshing NetBird state');
        void fetchState();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchState, state?.enabled, connectionState]);

  const effectiveManagementUrl = serverMode === 'selfHosted' ? managementUrl.trim() : '';
  const managementUrlError =
    serverMode === 'selfHosted' && !effectiveManagementUrl
      ? t('settings:accessibility.netbird.errors.managementUrlRequired')
      : !isValidManagementUrl(effectiveManagementUrl)
        ? t('settings:accessibility.netbird.errors.invalidManagementUrl')
        : '';
  const hostnameError = isValidPeerHostname(hostname)
    ? ''
    : t('settings:accessibility.netbird.errors.invalidHostname');
  const settingsDirty =
    !!state &&
    (effectiveManagementUrl !== (state.managementUrl ?? '') ||
      hostname.trim() !== (state.hostname ?? ''));

  const applySettings = useCallback(
    async (enabled: boolean) => {
      start('switchNetbird');
      const resp = await sendAsync(
        {
          method: 'switchNetbird',
          params: {
            enabled,
            managementUrl: effectiveManagementUrl || null,
            hostname: hostname.trim() || null,
          },
        },
        { showUnhandledErrorToast: true }
      );
      stop('switchNetbird');
      if (!resp.success) return false;
      return true;
    },
    [sendAsync, start, stop, effectiveManagementUrl, hostname]
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      if (enabled && (managementUrlError || hostnameError)) {
        toast.error(managementUrlError || hostnameError);
        return;
      }
      if (enabled) setConnectionState('connecting');
      if (!(await applySettings(enabled))) {
        await fetchState();
        return;
      }
      if (enabled) {
        // Give the daemon a moment to start and reconnect with an existing identity.
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
      await fetchState();
    },
    [applySettings, fetchState, managementUrlError, hostnameError]
  );

  const handleSaveSettings = useCallback(async () => {
    if (managementUrlError || hostnameError) return;
    if (await applySettings(true)) {
      toast.success(t('settings:accessibility.netbird.messages.settingsSaved'));
      await fetchState();
    }
  }, [applySettings, fetchState, managementUrlError, hostnameError, t]);

  const handleRegisterResult = useCallback(
    async (resp: RegisterNetbirdResponse) => {
      switch (resp.status) {
        case 'needsAuth':
          if (resp.authUrl) {
            setLoginUrl(resp.authUrl);
            setUserCode(resp.userCode ?? '');
            setAwaitingAuthSince(Date.now());
            window.open(resp.authUrl, '_blank', 'noopener,noreferrer');
          }
          break;
        case 'completed':
          setSetupKey('');
          toast.success(t('settings:accessibility.netbird.messages.joined'));
          break;
        case 'disabled':
          toast.error(t('settings:accessibility.netbird.messages.disabled'));
          break;
        default:
          toast.error(
            `${t('settings:accessibility.netbird.messages.registerFailed')}: ${netbirdErrorMessage(resp)}`
          );
      }
      await fetchState();
    },
    [fetchState, t]
  );

  const register = useCallback(
    async (withSetupKey: boolean) => {
      // Persist pending server/hostname edits first; they are used by `netbird up`.
      if (settingsDirty && !(await applySettings(true))) return;

      start('registerNetbird');
      setConnectionState('connecting');
      const resp = await sendAsync(
        {
          method: reauth ? 'registerNetbirdForce' : 'registerNetbird',
          params: { setupKey: withSetupKey ? setupKey.trim() : null },
        },
        { timeout: 90000, showUnhandledErrorToast: true }
      );
      stop('registerNetbird');
      if (!resp.success) {
        await fetchState();
        return;
      }
      await handleRegisterResult(resp.result);
    },
    [applySettings, settingsDirty, sendAsync, start, stop, reauth, setupKey, fetchState, handleRegisterResult]
  );

  if (!state?.available) return null;

  const busy = isLoading('switchNetbird') || isLoading('registerNetbird');
  const showAuth = state.enabled && (reauth || (connectionState !== 'connected' && connectionState !== 'connecting'));
  const peers = state.status?.peers;
  const sessionExpiresAt = state.status?.sessionExpiresAt
    ? new Date(state.status.sessionExpiresAt)
    : null;

  return (
    <SettingBlock
      title={t('settings:accessibility.netbird.title')}
      content={t('settings:accessibility.netbird.desc')}
    >
      <SettingBlock.Right>
        <Switch
          checked={state.enabled}
          onCheckedChange={enabled => void handleToggle(enabled)}
          disabled={!isChannelReady || busy}
        />
      </SettingBlock.Right>

      <SettingBlock.Bottom>
        <div className="flex flex-col gap-4 p-6 rounded-lg border border-(--border-color)">
          {/* Control plane */}
          <div className="flex flex-col gap-3">
            <div className="flex justify-between items-center gap-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-text">
                  {t('settings:accessibility.netbird.fields.server')}
                </span>
                <span className="text-xs text-text-muted">
                  {t('settings:accessibility.netbird.serverHint')}
                </span>
              </div>
              <Select
                value={serverMode}
                size="xs"
                onChange={value => setServerMode(value as ServerMode)}
                options={[
                  { value: 'cloud', label: t('settings:accessibility.netbird.server.cloud') },
                  { value: 'selfHosted', label: t('settings:accessibility.netbird.server.selfHosted') },
                ]}
                disabled={busy}
              />
            </div>
            {serverMode === 'selfHosted' && (
              <Input
                label={t('settings:accessibility.netbird.fields.managementUrl')}
                labelPosition="top"
                labelSize={12}
                labelClassName="text-text text-xs"
                placeholder="https://netbird.example.com"
                value={managementUrl}
                size="xs"
                onChange={e => setManagementUrl(e.target.value)}
                aria-invalid={!!managementUrlError}
                className={managementUrlError ? 'border-destructive' : ''}
                description={
                  managementUrlError || t('settings:accessibility.netbird.managementUrlHint')
                }
                disabled={busy}
              />
            )}
            <Input
              label={t('settings:accessibility.netbird.fields.hostname')}
              labelPosition="top"
              labelSize={12}
              labelClassName="text-text text-xs"
              placeholder={t('settings:accessibility.netbird.hostnamePlaceholder')}
              value={hostname}
              size="xs"
              onChange={e => setHostname(e.target.value)}
              aria-invalid={!!hostnameError}
              className={hostnameError ? 'border-destructive' : ''}
              description={hostnameError || undefined}
              disabled={busy}
            />
            {state.enabled && settingsDirty && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-text-muted">
                  {t('settings:accessibility.netbird.messages.serverChangeWarning')}
                </p>
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={() => void handleSaveSettings()}
                    disabled={busy || !!managementUrlError || !!hostnameError}
                    loading={isLoading('switchNetbird')}
                  >
                    {t('settings:accessibility.netbird.actions.save')}
                  </Button>
                </div>
              </div>
            )}
            {!state.enabled && (
              <p className="text-xs text-text-muted">
                {t('settings:accessibility.netbird.enableHint', {
                  server: effectiveManagementUrl || NETBIRD_CLOUD_MANAGEMENT_URL,
                })}
              </p>
            )}
          </div>

          {tailscaleEnabled && state.enabled && (
            <p className="text-xs text-text-muted border-l-2 border-yellow-500 pl-3">
              {t('settings:accessibility.netbird.messages.tailscaleOverlap')}
            </p>
          )}

          {state.enabled && state.error && connectionState !== 'connected' && (
            <p className="text-xs text-text-muted">
              {t('settings:accessibility.netbird.messages.statusUnavailable')}
            </p>
          )}

          {/* Authentication */}
          {showAuth && (
            <div className="flex flex-col gap-4 pt-4 border-t border-(--border-color)">
              <p className="text-sm text-text-secondary">
                {t('settings:accessibility.netbird.actions.authHint')}
              </p>

              {/* SSO */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={() => void register(false)}
                    disabled={busy || !!managementUrlError || !!hostnameError}
                    loading={isLoading('registerNetbird') && !setupKey}
                  >
                    {t('settings:accessibility.netbird.actions.ssoLogin')}
                  </Button>
                  {loginUrl && (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => window.open(loginUrl, '_blank', 'noopener,noreferrer')}
                    >
                      {t('settings:accessibility.netbird.actions.openLogin')}
                    </Button>
                  )}
                </div>
                {loginUrl && userCode && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-text-muted">
                      {t('settings:accessibility.netbird.fields.userCode')}
                    </span>
                    <span className="font-mono font-medium text-text select-text">{userCode}</span>
                    <CopyButton text={userCode} label="Code" variant="ghost" size="xs" />
                  </div>
                )}
                {awaitingAuthSince !== null && (
                  <p className="text-xs text-text-muted">
                    {t('settings:accessibility.netbird.messages.waitingForLogin')}
                  </p>
                )}
              </div>

              {/* Setup key */}
              <div className="flex flex-col gap-2">
                <Input
                  label={t('settings:accessibility.netbird.fields.setupKey')}
                  labelPosition="top"
                  labelSize={12}
                  labelClassName="text-text text-xs"
                  type="password"
                  autoComplete="off"
                  placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                  value={setupKey}
                  size="xs"
                  onChange={e => setSetupKey(e.target.value)}
                  description={`${t('settings:accessibility.netbird.setupKeyHint')} ${t('settings:accessibility.netbird.setupKeyRecommended')}`}
                  disabled={busy}
                />
                <div className="flex justify-end gap-2">
                  {reauth && (
                    <Button variant="outline" size="xs" onClick={() => setReauth(false)} disabled={busy}>
                      {t('settings:accessibility.netbird.actions.cancel')}
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    size="xs"
                    onClick={() => void register(true)}
                    disabled={busy || !setupKey.trim() || !!managementUrlError || !!hostnameError}
                    loading={isLoading('registerNetbird') && !!setupKey}
                  >
                    {t('settings:accessibility.netbird.actions.joinWithKey')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Connecting */}
          {state.enabled && !reauth && connectionState === 'connecting' && (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Loading type="spinner" size="md" color="blue" />
              <p className="text-sm text-text-muted">
                {t('settings:accessibility.netbird.status.connecting')}
              </p>
            </div>
          )}

          {/* Connected */}
          {state.enabled && !reauth && connectionState === 'connected' && (
            <div className="flex flex-col pt-4 border-t border-(--border-color)">
              <div className="flex justify-between items-center pb-4 border-b border-(--border-color)">
                <div className="flex flex-col">
                  <span className="text-sm text-text-muted">
                    {t('settings:accessibility.netbird.fields.management')}
                  </span>
                  <span className="text-sm font-medium text-text select-text break-all">
                    {state.status?.management.url || state.managementUrl || NETBIRD_CLOUD_MANAGEMENT_URL}
                  </span>
                </div>
                <Button variant="outline" size="xs" onClick={() => setReauth(true)} disabled={busy}>
                  {t('settings:accessibility.netbird.actions.change')}
                </Button>
              </div>
              <div className="flex justify-between items-center py-4 border-b border-(--border-color)">
                <span className="text-sm text-text-muted">
                  {t('settings:accessibility.netbird.fields.status')}
                </span>
                <span className="text-sm font-medium text-text">
                  {t('settings:accessibility.netbird.status.connected')}
                  {peers && peers.total > 0 && (
                    <span className="text-text-muted font-normal">
                      {' '}
                      ·{' '}
                      {t('settings:accessibility.netbird.peers', {
                        connected: peers.connected,
                        total: peers.total,
                      })}
                    </span>
                  )}
                </span>
              </div>
              {state.ip && (
                <div className="flex justify-between items-center py-4 border-b border-(--border-color)">
                  <span className="text-sm text-text-muted">
                    {t('settings:accessibility.netbird.fields.netbirdIp')}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text select-text">{state.ip}</span>
                    <CopyButton text={state.ip} label="NetBird IP" variant="ghost" size="xs" />
                  </div>
                </div>
              )}
              {sessionExpiresAt && !Number.isNaN(sessionExpiresAt.getTime()) && (
                <div className="flex flex-col gap-1 py-4 border-b border-(--border-color)">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-text-muted">
                      {t('settings:accessibility.netbird.fields.loginExpires')}
                    </span>
                    <span className="text-sm font-medium text-text">
                      {sessionExpiresAt.toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted border-l-2 border-yellow-500 pl-3">
                    {t('settings:accessibility.netbird.messages.loginExpiryWarning')}
                  </p>
                </div>
              )}
              {state.fqdn && (
                <div className="flex justify-between items-center pt-4">
                  <span className="text-sm text-text-muted">
                    {t('settings:accessibility.netbird.fields.fqdn')}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text select-text">{state.fqdn}</span>
                    <CopyButton text={state.fqdn} label="FQDN" variant="ghost" size="xs" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingBlock.Bottom>
    </SettingBlock>
  );
}
