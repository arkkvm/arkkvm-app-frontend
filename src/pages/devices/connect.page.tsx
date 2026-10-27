import { request } from '@/api';
import { readDeviceBindingConflict, type DeviceBindingResponse } from '@/api/deviceBinding';
import ConnectDevice from '@/components/auth/ConnectDevice';
import { useAppStore } from '@/stores';
import type { UserInfo } from '@/stores/slices/userSlice';
import {
  beginCloudRegistrationContext,
  clearCloudRegistrationContext,
  logCloudRegistration,
  readCloudRegistrationContext,
  saveCloudRegistrationName,
  saveCloudRegistrationCredentials,
} from '@/utils/cloudRegistrationContext';
import { parseVersions } from '@/utils/parse';
import { normalizeDeviceId } from '@/utils/security';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

export const meta = {
  path: '/devices/:id/connect',
  cloudPath: '/devices/:id/connect',
  target: 'cloud',
};

type Account = Pick<UserInfo, 'email' | 'displayName' | 'identities'>;
type DeviceDetail = { id?: unknown; name?: unknown; cloudVersion?: unknown };
type Flow =
  | 'loading'
  | 'confirm'
  | 'handoff'
  | 'savingName'
  | 'loadingDevice'
  | 'success'
  | 'failed';

export default function ConnectDevicePage() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { id: rawId } = useParams();
  const [searchParams] = useSearchParams();
  const deviceId = normalizeDeviceId(rawId);
  const completing = searchParams.get('complete') === '1';
  const getUserInfo = useAppStore(state => state.getUserInfo);
  const logout = useAppStore(state => state.logout);
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState('arkkvm');
  const [systemVersion, setSystemVersion] = useState('');
  const [flow, setFlow] = useState<Flow>('loading');
  const [error, setError] = useState('');
  const [bindingConflict, setBindingConflict] = useState<ReturnType<typeof readDeviceBindingConflict>>(null);
  const preparedBinding = useRef<{ deviceId: string; pairingToken: string; webToken: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const confirmationRequest = useRef<{
    deviceId: string;
    webToken: string;
    attempt: number;
    promise: ReturnType<typeof request.post<DeviceBindingResponse>>;
  } | null>(null);
  const submitLock = useRef(false);
  const nameSaved = useRef(false);
  const switchLock = useRef(false);
  const completionContext = useRef<ReturnType<typeof readCloudRegistrationContext>>(null);

  useEffect(() => {
    preparedBinding.current = null;
    setBindingConflict(null);
    if (!deviceId) {
      navigate('/devices/list', { replace: true });
      return;
    }
    const context =
      readCloudRegistrationContext(deviceId) ||
      (nameSaved.current && completionContext.current?.deviceId === deviceId
        ? completionContext.current
        : null);
    if (!context || !context.pairingToken) {
      setError(t('deviceConnect.expired'));
      setFlow('failed');
      return;
    }
    setFlow('loading');
    setName(context.name);
    setSystemVersion(context.systemVersion);
    setError('');

    let cancelled = false;
    void (async () => {
      try {
        if (completing) {
          setAccount(await getUserInfo(true));
          if (cancelled) return;
          setFlow('savingName');
          const saved = nameSaved.current
            ? { success: true }
            : await request.put(`/devices/${deviceId}`, { name: context.name }, { timeout: 15000 });
          if (cancelled) return;
          if (!saved.success) {
            setError(t('deviceConnect.nameError'));
            setFlow('failed');
            return;
          }
          nameSaved.current = true;
          completionContext.current = context;
          clearCloudRegistrationContext();
          setFlow('loadingDevice');
          const detail = await request.get<DeviceDetail>(`/devices/${deviceId}`, {
            timeout: 15000,
          });
          if (cancelled) return;
          if (!detail.success || !detail.data) {
            setError(t('deviceConnect.deviceLoadError'));
            setFlow('failed');
            return;
          }
          setSystemVersion(parseVersions(detail.data.cloudVersion));
          setFlow('success');
          return;
        }

        const user = await getUserInfo(true);
        if (cancelled) return;
        if (!user) {
          setError(t('deviceConnect.accountError'));
          setFlow('failed');
          return;
        }
        setAccount(user);
        const webToken = localStorage.getItem('token');
        if (!webToken) throw new Error('Missing login session');
        // Reuse the in-flight result across effect replays and language changes.
        let preparation = confirmationRequest.current;
        if (!preparation || preparation.deviceId !== deviceId || preparation.webToken !== webToken ||
            preparation.attempt !== attempt) {
          preparation = {
            deviceId, webToken, attempt,
            promise: request.post<DeviceBindingResponse>(`/devices/${deviceId}/bind`, undefined, {
              timeout: 15000,
              headers: { Authorization: `Bearer ${webToken}` },
            }),
          };
          confirmationRequest.current = preparation;
        }
        const confirmation = await preparation.promise;
        if (cancelled) return;
        if (!confirmation.success || confirmation.data?.deviceId !== deviceId ||
            typeof confirmation.data.tempToken !== 'string' || !confirmation.data.tempToken) {
          setBindingConflict(readDeviceBindingConflict(confirmation.data));
          setError(t('deviceConnect.confirmationError'));
          setFlow('failed');
          return;
        }
        preparedBinding.current = { deviceId, pairingToken: confirmation.data.tempToken, webToken };
        setFlow('confirm');
      } catch {
        if (!cancelled) {
          setError(t(completing ? 'deviceConnect.nameError' : 'deviceConnect.deviceError'));
          setFlow('failed');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt, completing, deviceId, getUserInfo, navigate, t]);

  useEffect(() => {
    if (flow !== 'success') return;
    const timer = window.setTimeout(() => navigate('/devices/list', { replace: true }), 5000);
    return () => window.clearTimeout(timer);
  }, [flow, navigate]);

  const connect = async () => {
    if (!deviceId || flow !== 'confirm' || submitLock.current || switchLock.current) return;
    const context = readCloudRegistrationContext(deviceId);
    logCloudRegistration('connect-read-storage', deviceId, context || {}, {
      hasContext: !!context, ageMs: context ? Date.now() - context.createdAt : null,
    });
    if (!context?.pairingToken || !saveCloudRegistrationName(deviceId, name)) {
      setError(t('deviceConnect.expired'));
      setFlow('failed');
      return;
    }
    submitLock.current = true;
    setError('');
    setFlow('handoff');
    try {
      const prepared = preparedBinding.current;
      if (!prepared || prepared.deviceId !== deviceId ||
          localStorage.getItem('token') !== prepared.webToken) {
        throw new Error('Account confirmation expired');
      }
      const { pairingToken, webToken } = prepared;
      if (!saveCloudRegistrationCredentials(deviceId, {
        pairingToken, webToken, oidcGoogle: context.oidcGoogle, clientId: context.clientId,
      })) throw new Error('Registration context expired');
      const params = new URLSearchParams({
        deviceId,
        token: pairingToken,
        loginToken: webToken,
        ...(context.oidcGoogle ? { oidcGoogle: context.oidcGoogle } : {}),
        ...(context.clientId ? { clientId: context.clientId } : {}),
      });
      logCloudRegistration('handoff-to-device', deviceId, { pairingToken, webToken }, {
        destinationOrigin: new URL(context.deviceReturnTo).origin,
      });
      window.location.replace(`${context.deviceReturnTo}?${params}`);
    } catch {
      setError(t('deviceConnect.confirmationError'));
      setFlow('failed');
    } finally {
      submitLock.current = false;
    }
  };

  const retry = () => {
    setAttempt(value => value + 1);
  };

  const switchAccount = async () => {
    if (!deviceId || switchLock.current || submitLock.current || completing) return;
    const context = readCloudRegistrationContext(deviceId);
    if (!context) return;
    switchLock.current = true;
    setSwitching(true);
    preparedBinding.current = null;
    setError('');
    try {
      // No binding exists before registration; switch only the login session.
      beginCloudRegistrationContext({
        deviceId,
        deviceReturnTo: context.deviceReturnTo,
        firmwareVersion: context.firmwareVersion,
        systemVersion: context.systemVersion,
        preserveName: true,
      });
      saveCloudRegistrationName(deviceId, name);
      const cleared = readCloudRegistrationContext(deviceId);
      logCloudRegistration('switch-account-credentials-cleared', deviceId, cleared || {}, {
        hasContext: !!cleared,
      });
      setFlow('handoff');
      const params = new URLSearchParams({
        deviceId,
        returnTo: `${window.location.origin}/ad-login`,
        deviceReturnTo: context.deviceReturnTo,
        switchAccount: '1',
        ...(context.firmwareVersion ? { fw: context.firmwareVersion } : {}),
      });
      await logout(`/login?${params}`);
    } catch {
      setError(t('deviceConnect.accountError'));
      setFlow('failed');
    } finally {
      switchLock.current = false;
      setSwitching(false);
    }
  };

  return (
    <ConnectDevice
      deviceId={deviceId || ''}
      name={name}
      systemVersion={systemVersion}
      account={account}
      loading={flow === 'loading'}
      submitting={['handoff', 'savingName', 'loadingDevice'].includes(flow)}
      switching={switching}
      error={error}
      bindingConflict={bindingConflict}
      blocked={flow !== 'confirm'}
      stage={
        flow === 'loading'
          ? 'loading'
          : flow === 'success'
            ? 'success'
            : flow === 'failed'
              ? 'failure'
              : completing
                ? 'complete'
                : 'confirm'
      }
      onDashboard={() => navigate('/devices/list', { replace: true })}
      onRetry={retry}
      onConnect={connect}
      onSaveName={async nextName => {
        if (!deviceId || !saveCloudRegistrationName(deviceId, nextName)) return false;
        setName(nextName);
        return true;
      }}
      onSwitchAccount={!completing ? () => void switchAccount() : undefined}
    />
  );
}
