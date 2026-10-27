import { request } from '@/api';
import { TopNavbar } from '@/components';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/stores';
import {
  logCloudRegistration,
  readCloudRegistrationContext,
  saveCloudRegistrationCredentials,
} from '@/utils/cloudRegistrationContext';
import { env } from '@/utils/env';
import {
  getSafeRedirectUrl,
  normalizeCloudOrigin,
  normalizeDeviceId,
  sanitizeError,
} from '@/utils/security';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';

export const meta = {};

interface CloudState {
  appUrl?: unknown;
}

export default function AdLoginRoute() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setToken = useAppStore(state => state.setToken);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const registrationComplete = useRef(false);
  const rawDeviceId = params.get('deviceId');
  const deviceId = normalizeDeviceId(rawDeviceId);
  const token = params.get('token');
  const loginToken = params.get('loginToken');
  const oidcGoogle = params.get('oidcGoogle');
  const clientId = params.get('clientId');
  const sn = params.get('sn');
  const redirectUrl = params.get('redirectUrl');

  useEffect(() => {
    logCloudRegistration(
      'callback-received',
      deviceId,
      { pairingToken: token, webToken: loginToken },
      {
        target: env.target,
        sn,
        attempt,
        hasOidcGoogle: !!oidcGoogle,
        hasClientId: !!clientId,
      }
    );
    if (!token || (rawDeviceId !== null && !deviceId)) {
      navigate('/', { replace: true });
      return;
    }

    if (sn === '1') {
      const safeUrl = getSafeRedirectUrl(redirectUrl);
      if (!safeUrl) {
        navigate('/', { replace: true });
        return;
      }
      const returnedPath = new URL(safeUrl, window.location.origin).pathname;
      const match = returnedPath.match(/^\/devices\/([^/]+)\/set-name$/);
      const returnedId = match ? normalizeDeviceId(decodeURIComponent(match[1])) : null;
      if (env.target !== 'cloud') {
        setToken(token);
        window.location.replace(safeUrl);
        return;
      }
      const context = returnedId ? readCloudRegistrationContext(returnedId) : null;
      const existingToken = localStorage.getItem('token');
      const candidates = [...new Set([
        loginToken, context?.webToken, existingToken, token,
      ].filter((value): value is string => Boolean(value)))];
      const controller = new AbortController();
      let cancelled = false;
      void (async () => {
        for (const candidate of candidates) {
          try {
            // A legacy callback may echo a consumed pairing token. Probe without
            // replacing the current session or triggering the global 401 redirect.
            const result = await request.get('/me', {
              baseURL: env.apiBaseUrl,
              headers: { Authorization: `Bearer ${candidate}` },
              signal: controller.signal,
              timeout: 10000,
            });
            if (cancelled) return;
            if (!result.success || !result.data) continue;
            setToken(candidate);
            if (returnedId && context) {
              navigate(`/devices/${encodeURIComponent(returnedId)}/connect?complete=1`, {
                replace: true,
              });
            } else {
              window.location.replace(safeUrl);
            }
            return;
          } catch {
            if (cancelled) return;
          }
        }
        if (!cancelled) {
          // Plain web login resumes naming; do not restart device registration.
          if (localStorage.getItem('token') === existingToken) setToken(null);
          navigate('/login', { replace: true, state: { from: { pathname: returnedPath } } });
        }
      })();
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    if (!deviceId) {
      if (env.target === 'cloud') {
        setToken(loginToken || token);
        navigate('/devices/list', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
      return;
    }

    if (env.target === 'cloud') {
      setToken(loginToken || token);
      const stored = saveCloudRegistrationCredentials(deviceId, {
        pairingToken: token,
        webToken: loginToken,
        oidcGoogle,
        clientId,
      });
      const context = readCloudRegistrationContext(deviceId);
      logCloudRegistration('callback-stored', deviceId, context || {}, {
        stored,
        pairingMatchesCallback: context?.pairingToken === token,
        loginMatchesCallback: context?.webToken === loginToken,
      });
      if (process.env.NODE_ENV === 'development') {
        console.info('[cloud-registration:raw-callback]', {
          url: window.location.href,
          params: Array.from(params.entries()),
          registerPayload: { token, oidcGoogle, clientId },
          storedCredentials: {
            token: context?.pairingToken,
            loginToken: context?.webToken,
            oidcGoogle: context?.oidcGoogle,
            clientId: context?.clientId,
          },
        });
      }
      debugger;
      navigate(stored ? `/devices/${encodeURIComponent(deviceId)}/connect` : '/', {
        replace: true,
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setError('');
        if (!registrationComplete.current) {
          logCloudRegistration('device-register-request', deviceId, {
            pairingToken: token,
            webToken: loginToken,
          });
          const registerResult = await request.post(
            '/cloud/register',
            { token, oidcGoogle, clientId },
            { timeout: 30000 }
          );
          logCloudRegistration(
            'device-register-response',
            deviceId,
            {},
            { success: registerResult.success }
          );
          if (cancelled) return;
          if (!registerResult.success) {
            setError(sanitizeError(registerResult.message || t('deviceConnect.bindError')));
            return;
          }
          registrationComplete.current = true;
        }
        const stateResult = await request.get<CloudState>('/cloud/state', { timeout: 10000 });
        if (cancelled) return;
        const appOrigin = normalizeCloudOrigin(stateResult.data?.appUrl);
        if (!stateResult.success || !appOrigin) {
          setError(t('deviceConnect.cloudStateError'));
          return;
        }
        const completionUrl = `${appOrigin}/devices/${encodeURIComponent(deviceId)}/set-name`;
        const handoff = new URLSearchParams({
          sn: '1',
          redirectUrl: completionUrl,
          token: loginToken || token,
        });
        window.location.replace(`${appOrigin}/ad-login?${handoff}`);
      } catch (cause) {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : t('deviceConnect.bindError');
          setError(sanitizeError(message));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    clientId,
    deviceId,
    loginToken,
    navigate,
    oidcGoogle,
    rawDeviceId,
    redirectUrl,
    setToken,
    sn,
    t,
    token,
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <TopNavbar links={[]} showLoggedIn={false} />
      <main className="flex flex-1 items-center justify-center px-6 text-center">
        <div>
          <p className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {error || t('deviceConnect.finishing')}
          </p>
          {error && (
            <Button className="mt-5" onClick={() => setAttempt(value => value + 1)}>
              {t('deviceConnect.retry')}
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
