/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2026-04-07 14:23:31
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-05-19 18:35:48
 */
/** Runtime environment configuration for device/cloud modes. */

/** Deployment target: device (local KVM) or cloud (web service) */
import type { CloudRuntimeConfig } from './cloudRuntimeConfig';
import { getCloudRegions, type CloudRegion } from './cloudRegions';
export type { CloudRegion, CloudRegionId } from './cloudRegions';

type TargetMode = 'device' | 'cloud'
type ProtocolTarget = 'http' | 'ws'

const isHttps = window.location.protocol === 'https:';

const baseApiUrl = import.meta.env.RSB_API_BASE_URL || '';
const apiDomain = import.meta.env.RSB_API_DOMAIN || '';
const MODE = import.meta.env.RSB_MODE || import.meta.env.MODE || 'development';

const isDev = MODE === 'development' || import.meta.env.DEV === true;
// const isDev =false;

// device = local KVM device; cloud = cloud web service
const target: TargetMode =
  (import.meta.env.RSB_BUILD_TARGET as TargetMode) || 'device';
// test | pro (environment tier only, independent of local/cloud)
const envMode = import.meta.env.RSB_TARGET_MODE || 'test';
const defaultCloudRegions = getCloudRegions(envMode === 'test' ? 'test' : 'production');
const globalRegion = defaultCloudRegions[0];
const chinaRegion = defaultCloudRegions[1];
const officialCloudApiUrl = import.meta.env.RSB_API_BASE_URL_CLOUD || globalRegion.apiUrl;
const officialCloudAppUrl = import.meta.env.RSB_APP_BASE_URL_CLOUD || globalRegion.appUrl;
const officialCloudApiUrlCn = import.meta.env.RSB_API_BASE_URL_CLOUD_CN || chinaRegion.apiUrl;
const officialCloudAppUrlCn = import.meta.env.RSB_APP_BASE_URL_CLOUD_CN || chinaRegion.appUrl;

/**
 * Bundled official defaults, with existing build-time endpoint overrides.
 */
export const cloudRegions: CloudRegion[] = [
  { id: 'global', apiUrl: officialCloudApiUrl, appUrl: officialCloudAppUrl },
  { id: 'china', apiUrl: officialCloudApiUrlCn, appUrl: officialCloudAppUrlCn },
];

export function findCloudRegion(
  apiUrl: string | undefined,
  appUrl: string | undefined,
): CloudRegion | undefined {
  return cloudRegions.find(region => region.apiUrl === apiUrl && region.appUrl === appUrl);
}
function buildProtocolUrl(
  inputUrl: string,
  targetType: ProtocolTarget,
): string {
  const raw = inputUrl.trim() || window.location.origin;

  if (!raw) {
    return '';
  }

  const protocolMatch = raw.match(/^(https?:|wss?:)\/\//i);
  const hasProtocol = Boolean(protocolMatch);

  const currentPageProtocol =
    typeof window !== 'undefined' ? window.location.protocol : '';

  const isSecurePage = currentPageProtocol === 'https:';

  const getTargetProtocol = (secure: boolean, type: ProtocolTarget): string => {
    if (type === 'http') {
      return secure ? 'https://' : 'http://';
    }

    return secure ? 'wss://' : 'ws://';
  };

  if (hasProtocol) {
    const normalized = raw.replace(/^(https?:|wss?:)\/\//i, '');
    const originalProtocol = protocolMatch![1].toLowerCase();
    const isSecureSource =
      originalProtocol === 'https:' || originalProtocol === 'wss:';

    return `${getTargetProtocol(isSecureSource, targetType)}${normalized}`;
  }

  return `${getTargetProtocol(isSecurePage, targetType)}${raw}`;
}

/**
 * Whether the current context is secure (HTTPS or localhost)
 * Required for WebRTC and other secure APIs
 */
const isSecureContext = (() => {
  if (typeof window.isSecureContext !== 'undefined') {
    return window.isSecureContext;
  }
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(
    window.location.hostname
  );
  return isHttps || isLocalhost;
})();

const apiBaseUrl = isDev
  ? window.location.origin+'/api'
  : buildProtocolUrl(baseApiUrl, 'http');
const signalingUrl = isDev
  ? `${buildProtocolUrl(window.location.origin, 'ws')}/webrtc/signaling/client`
  : `${buildProtocolUrl(apiBaseUrl, 'ws')}/webrtc/signaling/client`;
let cloudRuntimeConfig: CloudRuntimeConfig | undefined;
let cloudInitialization: Promise<void> | undefined;

/** Resolve once, before importing the cloud application and its API modules. */
export function initializeCloudEnvironment(): Promise<void> {
  if (target !== 'cloud' || isDev) return Promise.resolve();
  cloudInitialization ??= import('./cloudRuntimeConfig').then(async ({ resolveCloudRuntimeConfig, deriveCloudRegions }) => {
    const legacy = baseApiUrl.trim() ? {
      apiBaseUrl,
      appBaseUrl: window.location.origin,
    } : undefined;
    const resolved = await resolveCloudRuntimeConfig(window.location, legacy);
    // Keep all original self-hosted settings, including a separate login URL.
    if (resolved.source !== 'legacy') {
      cloudRuntimeConfig = resolved;
      const regions = deriveCloudRegions(resolved);
      if (regions.length) cloudRegions.splice(0, cloudRegions.length, ...regions);
    }
  });
  return cloudInitialization;
}

export const env = {
  baseApiUrl,
  apiDomain,
  target,
  envMode,
  isDev,
  isHttps,
  isSecureContext,
  get apiBaseUrl() { return cloudRuntimeConfig?.apiBaseUrl ?? apiBaseUrl; },
  get appBaseUrl() { return cloudRuntimeConfig?.appBaseUrl ?? window.location.origin; },
  get signalingUrl() {
    return cloudRuntimeConfig
      ? `${buildProtocolUrl(cloudRuntimeConfig.apiBaseUrl, 'ws')}/webrtc/signaling/client`
      : signalingUrl;
  },
  officialCloudApiUrl,
  officialCloudAppUrl,
  officialCloudApiUrlCn,
  officialCloudAppUrlCn,
  cloudRegions,
  get loginCloudUrl() { return cloudRuntimeConfig?.apiBaseUrl ?? buildProtocolUrl(apiDomain, 'http'); }
} as const;


export type Env = typeof env
