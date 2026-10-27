/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-10-10 15:53:00
 */
export const meta = {
  auth: false,
  title: 'Cloud Login',
  isMenu: false,
  cloudPath: '/login',
  target: 'cloud',
};
import { createLogger } from '@/utils/logger';
import {
  IconAppleLogo,
  IconGitHubLogo,
  IconGoogleLogo,
  IconMicrosoftLogo,
  IconWeChatLogo,
} from '@/assets/icons';
import { AuthLayout, WelcomeBackground } from '@/components';
import { request } from '@/api';
import { getIPLocation } from '@/api/ip';
import { Button } from '@/components/ui/button';
import { LanguageSwitcher } from '@/components/settings/LanguageSwitcher';
import type { LoginOption } from '@/components/auth/AuthLayout';
import { cloudRegions, env } from '@/utils/env';
import { firmwareSupportsMultiProvider } from '@/utils/firmware';
import { beginCloudRegistrationContext } from '@/utils/cloudRegistrationContext';
import { getSafeExternalUrl, normalizeCloudOrigin, normalizeDeviceId } from '@/utils/security';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const logger = createLogger('CloudLogin');

/**
 * Providers the UI knows how to render (doc 14 §4). WeChat renders the
 * standard qrconnect flow (scan-to-login); it only appears when the cloud
 * registers it, i.e. its open-platform credentials are configured.
 */
const KNOWN_PROVIDERS = ['google', 'github', 'microsoft', 'wechat', 'apple'] as const;

/** Placeholder rows shown while the provider list loads. */
const PROVIDERS_SKELETON_COUNT = 2;

const PROVIDER_META: Record<
  string,
  { name: string; Icon?: React.ComponentType<React.SVGProps<SVGSVGElement>> }
> = {
  google: { name: 'Google', Icon: IconGoogleLogo },
  github: { name: 'GitHub', Icon: IconGitHubLogo },
  microsoft: { name: 'Microsoft', Icon: IconMicrosoftLogo },
  apple: { name: 'Apple', Icon: IconAppleLogo },
  wechat: { name: 'WeChat', Icon: IconWeChatLogo },
};

export default function LoginCloudPage() {
  return <LoginCloudContent />;
}

function LoginLanguageSelector() {
  return (
    <div className="flex justify-end px-4 py-4 sm:px-6 sm:py-6">
      <LanguageSwitcher bordered={false} showIcon />
    </div>
  );
}

function LoginCloudContent() {
  const { t } = useTranslation('common');
  const [sq] = useSearchParams();

  let cloudApiUrl: string | null = '';
  if (env.target === 'device') {
    cloudApiUrl = normalizeCloudOrigin(sq.get('cloudApiUrl'));
  } else {
    cloudApiUrl = normalizeCloudOrigin(env.loginCloudUrl);
  }
  const deviceId = normalizeDeviceId(sq.get('deviceId'));
  const pairingFirmware = sq.get('fw');
  const actionUrl = cloudApiUrl ? `${cloudApiUrl}/oidc/google` : '';

  useEffect(() => {
    if (!deviceId) return;
    // Older device webapps put their callback directly in returnTo.
    const legacyReturnOrigin = normalizeCloudOrigin(sq.get('returnTo'));
    const deviceReturnTo = sq.get('deviceReturnTo') ||
      (legacyReturnOrigin && legacyReturnOrigin !== window.location.origin
        ? `${legacyReturnOrigin}/ad-login`
        : null);
    if (deviceReturnTo) {
      beginCloudRegistrationContext({
        deviceId,
        deviceReturnTo,
        firmwareVersion: pairingFirmware,
        preserveName: sq.get('switchAccount') === '1',
        systemVersion: sq.get('systemVersion'),
      });
    }
  }, [deviceId, pairingFirmware, sq]);

  const isRegionalLogin = env.target === 'cloud' && !deviceId && !sq.get('client');
  const previewRegion = env.isDev ? sq.get('previewRegion') : null;
  const isRegionPreview = previewRegion === 'china' || previewRegion === 'global';
  const currentRegion = cloudRegions.find(
    region => normalizeCloudOrigin(region.appUrl) === window.location.origin
  ) ?? (env.isDev ? cloudRegions.find(
    region => normalizeCloudOrigin(region.apiUrl) === normalizeCloudOrigin(env.loginCloudUrl)
  ) : undefined);
  const isChinaCloud = currentRegion?.id === 'china' || cloudRegions.some(
    region => region.id === 'china' && normalizeCloudOrigin(region.apiUrl) === cloudApiUrl
  );
  const [countryCode, setCountryCode] = useState<string | null>(null);
  const [regionDismissed, setRegionDismissed] = useState(false);
  useEffect(() => {
    setCountryCode(null);
    if (!isRegionalLogin || isRegionPreview) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let cancelled = false;
    (async () => {
      try {
        const { success, data } = await getIPLocation(controller.signal);
        if (cancelled) return;
        if (
          success &&
          data?.isPublic === true &&
          typeof data.countryCode === 'string' &&
          /^[A-Z]{2}$/.test(data.countryCode)
        ) {
          setCountryCode(data.countryCode);
        }
        // Older clouds, private addresses and unknown countries fail open.
      } catch {
        // Do not log raw responses, IP addresses or authentication parameters.
        if (!cancelled)
          logger.warn('[login-region] lookup unavailable', {
            reason: controller.signal.aborted ? 'timeout' : 'network-cors-or-csp',
          });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [isRegionalLogin, currentRegion, isRegionPreview]);
  const suggestedRegionId = isRegionPreview
    ? previewRegion
    : countryCode === 'CN'
      ? 'china'
      : 'global';
  const regionNoticeLanguage = suggestedRegionId === 'china' ? 'zh' : 'en';
  const suggestedRegion =
    isRegionPreview || (countryCode && currentRegion && currentRegion.id !== suggestedRegionId)
      ? cloudRegions.find(region => region.id === suggestedRegionId)
      : undefined;
  const switchOrigin = suggestedRegion ? getSafeExternalUrl(suggestedRegion.appUrl) : null;
  const switchUrl = switchOrigin ? new URL('/login', switchOrigin) : null;
  if (switchUrl && deviceId && suggestedRegion) {
    switchUrl.searchParams.set('deviceId', deviceId);
    // Carry only binding metadata, never arbitrary authentication parameters.
    for (const key of ['returnTo', 'deviceReturnTo', 'fw', 'systemVersion', 'switchAccount']) {
      const value = sq.get(key);
      if (value) switchUrl.searchParams.set(key, value);
    }
    switchUrl.searchParams.set('cloudApiUrl', suggestedRegion.apiUrl);
  }

  // Enabled providers come from the cloud (additive endpoint, doc 14 §4).
  // null = still loading: the layout shows placeholders instead of a Google
  // button that would be joined by the others a round trip later. Failure,
  // timeout or an older cloud fall back to Google outside China only.
  // Retry once before falling back when the cloud request fails.
  const [providers, setProviders] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setProviders(null);
    (async () => {
      for (let i = 0; i < 2; i++) {
        try {
          const { success, data } = await request.get<{ providers?: unknown }>('/oidc/providers', {
            signal: controller.signal,
          });
          if (cancelled) return;
          if (!success) continue;
          const list = data?.providers;
          const known = Array.isArray(list)
            ? list.filter(
                (p): p is string =>
                  typeof p === 'string' && (KNOWN_PROVIDERS as readonly string[]).includes(p)
              )
            : [];
          setProviders(known.length > 0 ? known : isChinaCloud ? [] : ['google']);
          return;
        } catch {
          if (cancelled) return;
        }
      }
      setProviders(isChinaCloud ? [] : ['google']);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isChinaCloud]);

  // Pairing gate (doc 14 §4): only the pairing path (deviceId present) is
  // gated — a device webapp that appends `fw` ships inside the
  // de-providerized firmware bundle; legacy webapps send no fw, so their
  // users must upgrade in China; elsewhere only Google is offered.
  const multiFirmware = deviceId ? firmwareSupportsMultiProvider(pairingFirmware) : true;
  const requiresFirmwareUpgrade = isChinaCloud && !multiFirmware;
  const visibleProviders = (multiFirmware ? (providers ?? []) : ['google'])
    .filter(provider => !isChinaCloud || provider !== 'google');

  const loginOptions: LoginOption[] | undefined = useMemo(() => {
    if (!cloudApiUrl) return undefined;
    return visibleProviders
      .map((provider): LoginOption | null => {
        const meta = PROVIDER_META[provider];
        if (!meta) return null;
        return {
          label: t(deviceId ? 'cloudLogin.actionProvider' : 'cloudLoginDirect.actionProvider', {
            provider: meta.name,
          }),
          icon: meta.Icon,
          actionUrl: `${cloudApiUrl}/oidc/${provider}`,
        };
      })
      .filter((option): option is LoginOption => option !== null);
  }, [visibleProviders, cloudApiUrl, deviceId, t]);

  const optionsPending = providers === null;

  // MCP consent gate (cloud migration/15 §3): the local MCP tool marks its
  // login with client=mcp; show the authorization card first and only render
  // the provider buttons after an explicit allow. Cancel shows a terminal
  // state — the tool's loopback wait simply times out.
  const isMcp = sq.get('client') === 'mcp';
  const [mcpAllowed, setMcpAllowed] = useState(false);
  const [mcpDenied, setMcpDenied] = useState(false);
  if (isMcp && !mcpAllowed) {
    return (
      <>
        <LoginLanguageSelector />
        <McpConsentCard
          denied={mcpDenied}
          onAllow={() => setMcpAllowed(true)}
          onDeny={() => setMcpDenied(true)}
        />
      </>
    );
  }


  return (
    <>
      {isRegionalLogin && switchUrl && !regionDismissed && (
        <div
          role="status"
          lang={regionNoticeLanguage}
          className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-accent px-4 py-3 text-sm text-accent-foreground"
        >
          <span className="whitespace-pre-line text-center">{t(`cloudRegionNotice.${suggestedRegionId}`, { lng: regionNoticeLanguage })}</span>
          <a
            className="font-medium underline underline-offset-4"
            href={switchUrl.href}
          >
            {t('cloudRegionNotice.switch', { lng: regionNoticeLanguage })}
          </a>
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => setRegionDismissed(true)}
          >
            {t('cloudRegionNotice.dismiss', { lng: regionNoticeLanguage })}
          </button>
        </div>
      )}
      <LoginLanguageSelector />
      <AuthLayout
        title={t(deviceId ? 'cloudLogin.title' : 'cloudLoginDirect.title')}
        description={t(deviceId ? 'cloudLogin.description' : 'cloudLoginDirect.description')}
        action={t(deviceId ? 'cloudLogin.action' : 'cloudLoginDirect.action')}
        footerText={t(deviceId ? 'cloudLogin.encryptedHint' : 'cloudLoginDirect.encryptedHint')}
        leadingIcon={IconGoogleLogo}
        actionUrl={actionUrl}
        loginOptions={loginOptions}
        unavailableMessage={requiresFirmwareUpgrade
          ? t('cloudLogin.upgradeFirmware')
          : isChinaCloud && !optionsPending && visibleProviders.length === 0
            ? t('cloudLogin.providersUnavailable')
            : undefined}
        optionsPending={optionsPending && !requiresFirmwareUpgrade}
        skeletonCount={PROVIDERS_SKELETON_COUNT}
      />
    </>
  );
}

/**
 * MCP authorization card (cloud migration/15 §3): explicit consent before
 * the OAuth flow hands a grant code to the local tool. Visual style follows
 * AuthLayout (same WelcomeBackground + button treatment).
 */
function McpConsentCard({
  denied,
  onAllow,
  onDeny,
}: {
  denied: boolean;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation('common');
  const buttonClass =
    'w-full h-[48px] bg-(--btn-outline-bg) hover:bg-(--btn-outline-bg-hover) text-(--btn-outline-text) font-medium text-[15px] rounded-[12px] border border-(--btn-outline-border) shadow-lg shadow-(--bg-primary)/15 transition-all duration-200 ease-out hover:shadow-xl hover:shadow-(--bg-primary)/25 hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center';

  if (denied) {
    return (
      <WelcomeBackground
        title={t('mcpConsent.deniedTitle')}
        subtitle={t('mcpConsent.deniedDescription')}
        className="bg-(--bg-primary)"
        minHeight="min-h-screen"
      />
    );
  }
  return (
    <WelcomeBackground
      title={t('mcpConsent.title')}
      subtitle={t('mcpConsent.description')}
      className="bg-(--bg-primary)"
      minHeight="min-h-screen"
    >
      <div className="mt-8 w-[360px] max-w-[calc(100vw-40px)]">
        <div className="rounded-[12px] border border-(--border-color)/20 bg-(--bg-secondary) p-4 text-left text-[13px] leading-relaxed text-[var(--text-secondary)]/90">
          <p className="mb-2 font-medium text-text">{t('mcpConsent.scopeTitle')}</p>
          <p className="mb-2">{t('mcpConsent.scopes')}</p>
          <p>{t('mcpConsent.noScope')}</p>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <Button className={buttonClass} onClick={onAllow}>
            <span>{t('mcpConsent.allow')}</span>
          </Button>
          <Button
            variant="ghost"
            className="w-full h-[44px] text-[14px] text-[var(--text-secondary)] hover:text-text"
            onClick={onDeny}
          >
            <span>{t('mcpConsent.deny')}</span>
          </Button>
        </div>
      </div>
    </WelcomeBackground>
  );
}
