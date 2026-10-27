import { env } from './env';

function hasUnsafeUrlInput(value: string): boolean {
  return /[\u0000-\u0020\u007f-\u009f\\]/.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value);
}

/** Validate web URLs without granting OAuth redirect trust. */
export function getSafeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || hasUnsafeUrlInput(value)) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) return null;
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (loopback && !env.isDev) return null;
    if (url.protocol !== 'https:' && !(env.isDev && loopback && url.protocol === 'http:')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Validate configured cloud/device addresses, including self-hosted HTTP deployments. */
export function normalizeCloudOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || hasUnsafeUrlInput(raw) || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Generic redirects allow only local paths or the current origin, including self-hosted clouds. */
export function getSafeRedirectUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || hasUnsafeUrlInput(value)) return null;
  if (value.startsWith('/')) {
    if (value.startsWith('//') || /^\/(?:%2f|%5c)/i.test(value)) return null;
    return value;
  }
  const origin = normalizeCloudOrigin(value);
  return origin && origin === window.location.origin ? new URL(value).href : null;
}

/** Syntax only. Device identity and ownership must be verified by the backend. */
export function normalizeDeviceId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
    ? value : null;
}

/**
 * Sanitize a string for safe HTML rendering to prevent XSS attacks.
 * Escapes HTML special characters: < > " '
 */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
