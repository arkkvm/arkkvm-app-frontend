import { SETTINGS_RPC_METHODS as methods } from '@/api/rpc/methods';
import type { JsonRpcSendAsync } from '@/api/rpc/types';
/*
 * @Author: Lei Zhang daisy_zlei@163.com
 * @Date: 2026-06-26 14:34:26
 * @LastEditors: Lei Zhang daisy_zlei@163.com
 * @LastEditTime: 2026-07-03 20:39:51
 */
import type { JsonRpcResponse, JsonRpcSend, MethodParamsMap } from '@/hooks/useJsonRpc';
import type { DeviceSettings, UsbDeviceConfig } from '@/stores/devicesStore';

// Helper: unwrap JSON-RPC response
function getResult(resp: JsonRpcResponse): unknown {
  if ('error' in resp) throw new Error(resp.error.message || 'RPC error');
  return (resp as { result?: unknown }).result;
}

export type SendAsync = <M extends keyof MethodParamsMap>(
  call: JsonRpcSend<M>,
  opts?: { timeout?: number }
) => Promise<JsonRpcResponse>;

export async function fetchDeviceSettings(sendAsync: SendAsync): Promise<Partial<DeviceSettings>> {
  // Fetch required settings in parallel.
  const [updateStatusResp, netSettingsResp, jigglerResp, autoUpdateResp] = await Promise.all([
    sendAsync({ method: 'getUpdateStatus' }).catch(e => e),
    sendAsync({ method: 'getNetworkSettings' }).catch(e => e),
    sendAsync({ method: 'getJigglerState' }).catch(e => e),
    sendAsync({ method: 'getAutoUpdateState' }).catch(e => e),
  ]);
  const settings: Partial<DeviceSettings> = {};

  // Version information.
  try {
    const updateStatus = getResult(updateStatusResp as JsonRpcResponse) as Record<
      string,
      Record<string, unknown>
    >;
    // Device response shape: local.appVersion / local.systemVersion.
    settings.appVersion = String(updateStatus?.local?.appVersion ?? '');
    settings.systemVersion = String(updateStatus?.local?.systemVersion ?? '');
  } catch {}

  // Network settings mapping.
  try {
    const networkSettings = getResult(netSettingsResp as JsonRpcResponse) as Record<
      string,
      unknown
    >;
    settings.network = {
      mac_address: String(networkSettings?.mac_address ?? ''),
      hostname: String(networkSettings?.hostname ?? ''),
      http_proxy: String(networkSettings?.http_proxy ?? ''),
      domain: String(networkSettings?.domain ?? ''),
      ipv4_mode: String(networkSettings?.ipv4_mode ?? 'dhcp'),
      ipv6_mode: String(networkSettings?.ipv6_mode ?? 'slaac'),
      lldp_mode: String(networkSettings?.lldp_mode ?? ''),
      mdns_mode: String(networkSettings?.mdns_mode ?? 'auto'),
      time_sync_mode: String(networkSettings?.time_sync_mode ?? 'ntp+http'),
    };
  } catch {}

  // Mouse jiggler state.
  try {
    const jigglerState = getResult(jigglerResp as JsonRpcResponse) as Record<string, unknown>;
    settings.jiggler = !!jigglerState?.enabled;
  } catch {}

  // Auto-update state.
  try {
    const autoUpdateState = getResult(autoUpdateResp as JsonRpcResponse) as Record<string, unknown>;
    settings.autoUpdate = !!autoUpdateState?.enabled;
  } catch {}

  return settings;
}

// Unknown device fields are retained; only fields used by the settings UI are validated.
export function parseUsbDevices(value: unknown): UsbDeviceConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  if (
    !('keyboard' in value) ||
    typeof value.keyboard !== 'boolean' ||
    !('absolute_mouse' in value) ||
    typeof value.absolute_mouse !== 'boolean' ||
    !('relative_mouse' in value) ||
    typeof value.relative_mouse !== 'boolean' ||
    !('mass_storage' in value) ||
    typeof value.mass_storage !== 'boolean' ||
    !('microphone' in value) ||
    typeof value.microphone !== 'boolean'
  )
    return null;
  const adapter = 'network_adapter' in value ? value.network_adapter : undefined;
  let networkAdapter: UsbDeviceConfig['network_adapter'];
  if (adapter !== undefined) {
    if (
      typeof adapter !== 'object' ||
      adapter === null ||
      !('enable' in adapter) ||
      typeof adapter.enable !== 'boolean'
    )
      return null;
    networkAdapter = { ...adapter, enable: adapter.enable };
  }
  return {
    ...value,
    keyboard: value.keyboard,
    absolute_mouse: value.absolute_mouse,
    relative_mouse: value.relative_mouse,
    mass_storage: value.mass_storage,
    microphone: value.microphone,
    network_adapter: networkAdapter,
  };
}

export async function readForwardingSettings(send: JsonRpcSendAsync) {
  const [mcp, forwarding] = await Promise.all([
    send({ method: methods.getMcpEnabled }, { showUnhandledErrorToast: true }),
    send({ method: methods.getSshForwarding }, { showUnhandledErrorToast: true }),
  ]);
  if (!mcp.success || !forwarding.success) return null;
  if (typeof mcp.result !== 'boolean' || typeof forwarding.result !== 'boolean') return null;
  if (!mcp.result && forwarding.result) return null;
  return { mcpEnabled: mcp.result, sshForwarding: forwarding.result };
}

export function writeForwardingSetting(
  send: JsonRpcSendAsync,
  setting: 'mcp' | 'forwarding',
  enabled: boolean
) {
  return send(
    {
      method: setting === 'mcp' ? methods.setMcpEnabled : methods.setSshForwarding,
      params: { enabled },
    },
    { showUnhandledErrorToast: true }
  );
}

export async function readUsbForwardingSnapshot(send: JsonRpcSendAsync) {
  const [forwarding, usb] = await Promise.all([
    send({ method: methods.getSshForwarding }, { showUnhandledErrorToast: true }),
    send({ method: 'getUsbDevices' }, { showUnhandledErrorToast: true }),
  ]);
  if (!forwarding.success || typeof forwarding.result !== 'boolean' || !usb.success) return null;
  const devices = parseUsbDevices(usb.result);
  if (!devices || !devices.network_adapter || devices.network_adapter.enable !== forwarding.result)
    return null;
  return { forwarding: forwarding.result, devices };
}
