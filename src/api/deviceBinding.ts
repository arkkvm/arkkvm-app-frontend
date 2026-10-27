/** Optional, already-masked account information returned for a binding conflict. */
export function readDeviceBindingConflict(data: unknown): { account: string; provider: string } | null {
  if (typeof data !== 'object' || data === null || !('reason' in data) ||
      data.reason !== 'DEVICE_ALREADY_BOUND') return null;
  const hint = 'boundAccount' in data ? data.boundAccount : null;
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  if (typeof hint !== 'object' || hint === null) return { account: '', provider: '' };
  const name = text('maskedDisplayName' in hint ? hint.maskedDisplayName : null);
  const email = text('maskedEmail' in hint ? hint.maskedEmail : null);
  return {
    account: email || name,
    provider: text('provider' in hint ? hint.provider : null),
  };
}

export interface DeviceBindingResponse {
  deviceId?: string;
  tempToken?: string;
  reason?: string;
  action?: string;
  boundAccount?: unknown;
}
