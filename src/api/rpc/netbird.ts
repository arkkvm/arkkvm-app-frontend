/**
 * NetBird plugin RPC types (see arkkvm-app `plugin/netbird.rs`).
 *
 * NetBird is a WireGuard mesh VPN whose control plane can be self-hosted.
 * Field names follow `netbird status --json` (camelCase).
 */
export type NetbirdConnectionState =
  | 'connected'
  | 'connecting'
  | 'loggedOut'
  | 'offline'
  | 'unknown';

export interface NetbirdEndpointState {
  url: string;
  connected: boolean;
  error: string;
}

export interface NetbirdPeer {
  fqdn: string;
  netbirdIp: string;
  publicKey: string;
  /** Idle | Connecting | Connected */
  status: string;
  /** P2P | Relayed | '' */
  connectionType: string;
  lastStatusUpdate: string;
  lastWireguardHandshake: string;
  transferReceived: number;
  transferSent: number;
  /** Nanoseconds */
  latency: number;
}

export interface NetbirdStatus {
  peers: { total: number; connected: number; details: NetbirdPeer[] };
  cliVersion: string;
  daemonVersion: string;
  /** Idle | Connecting | Connected | NeedsLogin | LoginFailed | SessionExpired */
  daemonStatus: string;
  management: NetbirdEndpointState;
  signal: NetbirdEndpointState;
  relays: { total: number; available: number };
  /** CIDR notation, e.g. 100.92.1.2/16 */
  netbirdIp: string;
  netbirdIpv6: string;
  publicKey: string;
  usesKernelInterface: boolean;
  fqdn: string;
  networks: string[] | null;
  profileName: string;
}

export interface NetbirdStateResponse {
  /** false when the system image ships without NetBird */
  available: boolean;
  enabled: boolean;
  /** null = NetBird Cloud */
  managementUrl: string | null;
  hostname: string | null;
  connectionState?: NetbirdConnectionState;
  ip?: string;
  fqdn?: string;
  raw?: string;
  status: NetbirdStatus | null;
  /** Status could not be read (daemon starting, ...) */
  error?: string;
}

export interface SwitchNetbirdParams {
  enabled: boolean;
  managementUrl?: string | null;
  hostname?: string | null;
}

export interface RegisterNetbirdParams {
  /** Omit for SSO login; the key is never persisted on the device. */
  setupKey?: string | null;
}

export type RegisterNetbirdStatus = 'completed' | 'needsAuth' | 'disabled' | 'failed';

export interface RegisterNetbirdResponse {
  status: RegisterNetbirdStatus;
  code: number;
  stdout: string;
  stderr: string;
  authUrl: string | null;
  /** Device-flow code when the IdP does not embed it in authUrl */
  userCode: string | null;
}

/** Official NetBird Cloud management endpoint (used when managementUrl is empty). */
export const NETBIRD_CLOUD_MANAGEMENT_URL = 'https://api.netbird.io';

/** Mirrors `validate_management_url` in the firmware. */
export function isValidManagementUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return true; // empty = NetBird Cloud
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

/** Mirrors `validate_hostname` in the firmware. */
export function isValidPeerHostname(value: string): boolean {
  const name = value.trim();
  if (!name) return true; // empty = device hostname
  return name.length <= 63 && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name);
}

/** Last line of NetBird CLI output, for error toasts. */
export function netbirdErrorMessage(resp: RegisterNetbirdResponse): string {
  const log = [resp.stderr, resp.stdout].filter(Boolean).join('\n').trim();
  const last = log.split('\n').filter(Boolean).pop();
  return last ?? `exit ${resp.code}`;
}
