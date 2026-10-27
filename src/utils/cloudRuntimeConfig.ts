import { normalizeCloudOrigin } from './security';
import { getCloudRegions } from './cloudRegions';

export interface CloudRuntimeConfig {
  apiBaseUrl: string;
  appBaseUrl: string;
}

interface ResolvedCloudRuntimeConfig extends CloudRuntimeConfig {
  source: 'runtime' | 'hostname' | 'legacy' | 'origin';
}

export class CloudConfigError extends Error {
  constructor() {
    super('Invalid cloud configuration');
    this.name = 'CloudConfigError';
  }
}

const OFFICIAL_APP = /^app(-tst)?\.arkkvm\.(com|cn)$/;
const OFFICIAL_API = /^api(-tst)?\.arkkvm\.(com|cn)$/;

/** Region destinations are maintained in one bundled mapping. */
export function deriveCloudRegions(config: CloudRuntimeConfig) {
  const currentApp = new URL(config.appBaseUrl);
  if (!OFFICIAL_APP.test(currentApp.hostname)) return [];
  const regions = getCloudRegions(currentApp.hostname.startsWith('app-tst.') ? 'test' : 'production');
  return regions.map(region => {
    const appUrl = validateOrigin(region.appUrl);
    return {
      id: region.id,
      appUrl,
      apiUrl: appUrl === currentApp.origin ? config.apiBaseUrl : validateOrigin(region.apiUrl),
    };
  });
}

function validateOrigin(value: unknown): string {
  const origin = normalizeCloudOrigin(value);
  if (!origin || typeof value !== 'string') throw new CloudConfigError();
  const url = new URL(value.trim());
  if (url.pathname !== '/' || url.search || url.hash) throw new CloudConfigError();
  return origin;
}

export async function resolveCloudRuntimeConfig(
  location: Pick<Location, 'hostname' | 'origin'>,
  legacy?: CloudRuntimeConfig,
): Promise<ResolvedCloudRuntimeConfig> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const unavailable = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Runtime configuration timeout'));
      }, 3000);
    });
    const load = async () => {
      // Bootstrap only: no business API client or authentication headers yet.
      const response = await fetch(new URL('/runtime-config.json', location.origin), {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Runtime configuration unavailable');
      const body = await response.text();
      if (response.headers.get('content-type')?.includes('text/html') || /^\s*</.test(body)) {
        throw new Error('Runtime configuration returned HTML');
      }
      let config: unknown;
      try {
        config = JSON.parse(body);
      } catch {
        // An invalid JSON configuration is a deployment error, not an absence.
        throw new CloudConfigError();
      }
      if (!config || typeof config !== 'object' || Array.isArray(config) ||
        !('apiBaseUrl' in config) || !('appBaseUrl' in config)) throw new CloudConfigError();
      return {
        source: 'runtime' as const,
        apiBaseUrl: validateOrigin(config.apiBaseUrl),
        appBaseUrl: validateOrigin(config.appBaseUrl),
      };
    };
    return await Promise.race([load(), unavailable]);
  } catch (error) {
    if (error instanceof CloudConfigError) throw error;
    // Keep this visible in production; do not print the response or its URLs.
    console.warn('[cloud-config] Runtime configuration unavailable; using hostname, explicit self-hosted configuration, or current origin.');
    if (OFFICIAL_APP.test(location.hostname)) {
      const api = new URL(location.origin);
      api.hostname = location.hostname.replace(/^app/, 'api');
      return { source: 'hostname', apiBaseUrl: api.origin, appBaseUrl: location.origin };
    }
    // A bundle's official default must never route an unknown site to that cloud.
    const api = normalizeCloudOrigin(legacy?.apiBaseUrl);
    if (api && legacy && !OFFICIAL_API.test(new URL(api).hostname)) {
      return { ...legacy, source: 'legacy' };
    }
    return { source: 'origin', apiBaseUrl: location.origin, appBaseUrl: location.origin };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
