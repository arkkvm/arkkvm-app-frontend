import { normalizeCloudOrigin, normalizeDeviceId } from './security';

const KEY = 'arkkvm:pending-cloud-registration';
const MAX_AGE = 30 * 60 * 1000;

// Diagnostic only: never log raw credentials or URLs containing credentials.
export function logCloudRegistration(
  stage: string,
  deviceId: string | null,
  credentials: { pairingToken?: string | null; webToken?: string | null } = {},
  details: Record<string, string | number | boolean | null> = {}
): void {
  const timestamp = new Date().toISOString();
  console.info('[cloud-registration]', { stage, deviceId, timestamp, ...details });
  void (async () => {
    const fingerprint = async (value?: string | null) => {
      if (!value) return { present: false, length: 0, sha256: null };
      if (!globalThis.crypto?.subtle) {
        return { present: true, length: value.length, sha256: 'unavailable' };
      }
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
        .join('').slice(0, 16);
      return { present: true, length: value.length, sha256 };
    };
    const [pairingToken, loginToken] = await Promise.all([
      fingerprint(credentials.pairingToken), fingerprint(credentials.webToken),
    ]);
    console.info('[cloud-registration:credentials]', {
      stage, deviceId, timestamp, pairingToken, loginToken,
    });
  })().catch(() => {
    console.info('[cloud-registration:credentials]', { stage, deviceId, timestamp, fingerprintFailed: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CloudRegistrationContext {
  deviceId: string;
  deviceReturnTo: string;
  pairingToken: string | null;
  webToken: string | null;
  oidcGoogle: string | null;
  clientId: string | null;
  name: string;
  firmwareVersion: string;
  systemVersion: string;
  createdAt: number;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeDeviceCallback(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const origin = normalizeCloudOrigin(value);
  if (!origin) return null;
  try {
    return new URL(value).pathname === '/ad-login' ? `${origin}/ad-login` : null;
  } catch {
    return null;
  }
}

export function beginCloudRegistrationContext(input: {
  deviceId: string;
  deviceReturnTo: string;
  firmwareVersion?: string | null;
  preserveName?: boolean;
  systemVersion?: string | null;
}): void {
  const deviceId = normalizeDeviceId(input.deviceId);
  const deviceReturnTo = normalizeDeviceCallback(input.deviceReturnTo);
  if (!deviceId || !deviceReturnTo) return;
  const existing = readCloudRegistrationContext(deviceId);
  sessionStorage.setItem(KEY, JSON.stringify({
    deviceId,
    deviceReturnTo,
    pairingToken: null,
    webToken: null,
    oidcGoogle: null,
    clientId: null,
    name: input.preserveName ? existing?.name || 'arkkvm' : 'arkkvm',
    firmwareVersion: input.firmwareVersion || '',
    systemVersion: input.systemVersion || (input.preserveName ? existing?.systemVersion : '') || '',
    createdAt: Date.now(),
  } satisfies CloudRegistrationContext));
}

export function saveCloudRegistrationCredentials(
  deviceId: string,
  credentials: Pick<CloudRegistrationContext, 'pairingToken' | 'webToken' | 'oidcGoogle' | 'clientId'>
): boolean {
  const context = readCloudRegistrationContext(deviceId);
  if (!context || !credentials.pairingToken) return false;
  sessionStorage.setItem(KEY, JSON.stringify({ ...context, ...credentials }));
  return true;
}

export function saveCloudRegistrationName(deviceId: string, name: string): boolean {
  const context = readCloudRegistrationContext(deviceId);
  const trimmedName = name.trim();
  if (!context || !trimmedName) return false;
  sessionStorage.setItem(KEY, JSON.stringify({ ...context, name: trimmedName }));
  return true;
}

export function readCloudRegistrationContext(deviceId: string): CloudRegistrationContext | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    const normalizedId = normalizeDeviceId(deviceId);
    const deviceReturnTo = isRecord(value) ? normalizeDeviceCallback(value.deviceReturnTo) : null;
    if (!normalizedId || !isRecord(value) || normalizeDeviceId(value.deviceId) !== normalizedId ||
      !deviceReturnTo || typeof value.createdAt !== 'number' || value.createdAt > Date.now() ||
      Date.now() - value.createdAt > MAX_AGE) return null;
    return {
      deviceId: normalizedId,
      deviceReturnTo,
      pairingToken: optionalString(value.pairingToken),
      webToken: optionalString(value.webToken),
      oidcGoogle: optionalString(value.oidcGoogle),
      clientId: optionalString(value.clientId),
      name: optionalString(value.name) || 'arkkvm',
      firmwareVersion: optionalString(value.firmwareVersion) || '',
      systemVersion: optionalString(value.systemVersion) || '',
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

export function clearCloudRegistrationContext(): void {
  sessionStorage.removeItem(KEY);
}
