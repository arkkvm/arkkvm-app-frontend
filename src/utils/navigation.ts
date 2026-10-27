/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2026-01-29 21:10:01
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-04-20 17:13:59
 */
import { normalizeUrl } from './common';
import { env } from './env';
import { VERSION_INFO } from './version';
import { getSafeRedirectUrl } from './security';
/**
 * Get path with version prefix.
 * Production cloud environment automatically prepends version number;
 * development and device-side environments do not.
 */
export function getVersionedPath(path: string): string {
  let normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const isCloudProduction = env.target === 'cloud' && !env.isDev;

  if (isCloudProduction) {
    const version = VERSION_INFO.version;
    if (version) {
      normalizedPath = normalizedPath.replace(/^\/default(?=\/|$)/, '') || '/';
      return normalizeUrl(`/${version}${normalizedPath}`);
    }
  }

  return normalizeUrl(normalizedPath);
}


export function navigateWithVersion(path: string): void {
  if (!path.startsWith('/') || !getSafeRedirectUrl(path)) return;
  const versionedPath = getVersionedPath(path);
  window.location.href = versionedPath;
}


export function replaceWithVersion(path: string): void {
  if (!path.startsWith('/') || !getSafeRedirectUrl(path)) return;
  const versionedPath = getVersionedPath(path);
  window.location.replace(versionedPath);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface RedirectToIpOptions {
  delayMs?: number;
  /** Cloud mode: don't reload page, call this callback instead for WebRTC reconnect */
  onCloudReconnect?: () => void | Promise<void>;
}

/**
 * Redirect to a new IP address while preserving the current protocol, pathname and search.
 * Uses `window.location.replace` so the current page is not added to browser history.
 * @param ip - Target IPv4/IPv6 address or hostname
 * @param options - Optional configuration
 */
export async function redirectToIp(
  ip: string,
  options: number | RedirectToIpOptions = {}
): Promise<void> {
  const opts: RedirectToIpOptions =
    typeof options === 'number' ? { delayMs: options } : options;
  const { delayMs = 0, onCloudReconnect } = opts;

  if (delayMs > 0) await sleep(delayMs);

  if (env.target === 'cloud') {
    // Cloud mode: prefer callback-based reconnect instead of page reload
    if (onCloudReconnect) {
      await onCloudReconnect();
    } else {
      window.location.reload();
    }
    return;
  }

  const url = new URL(window.location.href);
  // Device network changes are not OAuth redirects. Accept a host, never a URL.
  if (!ip || /[\s/@?#\\%]/.test(ip)) return;
  try {
    const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
    const hostUrl = new URL(`http://${host}`);
    if (hostUrl.port || hostUrl.username || hostUrl.password || hostUrl.pathname !== '/') return;
    url.hostname = hostUrl.hostname;
  } catch {
    return;
  }
  url.port = '';
  window.location.replace(url.toString());
}
