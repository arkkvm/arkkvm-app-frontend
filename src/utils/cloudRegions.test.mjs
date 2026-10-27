import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCloudRegions } from './cloudRegions';

const endpointKeys = [
  'RSB_API_BASE_URL_CLOUD', 'RSB_APP_BASE_URL_CLOUD',
  'RSB_API_BASE_URL_CLOUD_CN', 'RSB_APP_BASE_URL_CLOUD_CN',
];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { location: new URL('http://192.168.77.39'), isSecureContext: false });
  vi.stubEnv('RSB_BUILD_TARGET', 'device');
  for (const key of endpointKeys) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['pro', 'production', 'test'])('device %s exposes both official regions without env addresses', async tier => {
  vi.stubEnv('RSB_TARGET_MODE', tier);
  const { cloudRegions, findCloudRegion, initializeCloudEnvironment } = await import('./env');
  await initializeCloudEnvironment();
  expect(cloudRegions.map(region => region.id)).toEqual(['global', 'china']);
  expect(cloudRegions[0]).toEqual({
    id: 'global',
    apiUrl: tier === 'test' ? 'https://api-tst.arkkvm.com' : 'https://api.arkkvm.com',
    appUrl: tier === 'test' ? 'https://app-tst.arkkvm.com' : 'https://app.arkkvm.com',
  });
  expect(findCloudRegion('https://api.arkkvm.cn', 'https://app.arkkvm.cn')?.id).toBe('china');
  expect(findCloudRegion('https://self-hosted.example.com', 'https://self-hosted.example.com')).toBeUndefined();
});

it('keeps endpoint overrides and fills missing fields from official defaults', async () => {
  vi.stubEnv('RSB_TARGET_MODE', 'pro');
  vi.stubEnv('RSB_API_BASE_URL_CLOUD', 'https://custom-api.example.com');
  vi.stubEnv('RSB_APP_BASE_URL_CLOUD_CN', 'https://custom-cn-app.example.com');
  const { cloudRegions } = await import('./env');
  expect(cloudRegions).toEqual([
    { id: 'global', apiUrl: 'https://custom-api.example.com', appUrl: 'https://app.arkkvm.com' },
    { id: 'china', apiUrl: 'https://api.arkkvm.cn', appUrl: 'https://custom-cn-app.example.com' },
  ]);
});

it('returns independent region lists without mutating bundled defaults', () => {
  const regions = getCloudRegions('production');
  regions[0].apiUrl = 'https://override.example.com';
  expect(getCloudRegions('production')[0].apiUrl).toBe('https://api.arkkvm.com');
});

it('uses explicit region API URLs while retaining the current runtime API override', async () => {
  const { deriveCloudRegions } = await import('./cloudRuntimeConfig');
  expect(deriveCloudRegions({
    appBaseUrl: 'https://app-tst.arkkvm.com',
    apiBaseUrl: 'https://runtime-api.example.com',
  })).toEqual([
    { id: 'global', apiUrl: 'https://runtime-api.example.com', appUrl: 'https://app-tst.arkkvm.com' },
    { id: 'china', apiUrl: 'https://api.arkkvm.cn', appUrl: 'https://app.arkkvm.cn' },
  ]);
});
