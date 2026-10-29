/**
 * Mutually exclusive private network overlay (see arkkvm-app `plugin/private_network.rs`).
 */
export type PrivateNetworkOverlay = 'tailscale' | 'netbird';

export type PrivateNetworkTarget = 'none' | PrivateNetworkOverlay;

/** `both` = legacy state from independent switches, or a switch in progress. */
export type PrivateNetworkSelection = PrivateNetworkTarget | 'both';

export interface PrivateNetworkOverlayState {
  /** The system image ships this overlay */
  available: boolean;
  enabled: boolean;
  connected: boolean;
  /** Overlay IPs and DNS names of this device */
  addresses: string[];
}

export interface PrivateNetworkState {
  selection: PrivateNetworkSelection;
  /** The previous overlay keeps running until this one is connected */
  pendingTarget: PrivateNetworkOverlay | null;
  tailscale: PrivateNetworkOverlayState;
  netbird: PrivateNetworkOverlayState;
}

export interface SetPrivateNetworkParams {
  target: PrivateNetworkTarget;
}

/** Normalize a host for comparison: lowercase, no IPv6 brackets, no trailing dot. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * Which overlay the current page was opened through, if any, by comparing the
 * page's hostname with the overlay addresses reported by the device.
 */
export function detectSessionOverlay(
  state: PrivateNetworkState | null | undefined,
  hostname: string
): PrivateNetworkOverlay | null {
  if (!state) return null;
  const host = normalizeHost(hostname);
  if (!host) return null;
  for (const overlay of ['tailscale', 'netbird'] as const) {
    if (state[overlay].addresses.some(a => normalizeHost(a) === host)) return overlay;
  }
  return null;
}
