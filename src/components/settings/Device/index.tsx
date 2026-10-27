import { SETTINGS_RPC_METHODS } from '@/api/rpc/methods';
import { parseUsbDevices, readForwardingSettings, readUsbForwardingSnapshot } from '@/services/deviceSettings';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
/**
 * @Author: zhanglei
 * @Date: 2026-06-04 17:45:28
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-10-08 15:23:44
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useJsonRpc } from '@/hooks/useJsonRpc';
import { useLoadingMap } from '@/hooks/useLoading';
import {
  type USBConfig,
  type UsbDeviceConfig,
  defaultUsbConfig,
  defaultUsbDeviceConfig,
  useActiveDeviceSettings,
  useSettingsActions,
  useSettingsStore,
} from '@/stores/devicesStore';

import {
  Select,
  Switch,
  SettingBlock,
  UsbConfigForm,
  UsbDeviceSetting,
  SettingPageContainer,
  UsbDeviceSwitchGroup,
} from '@/components';
import type { UsbConfigFormRef } from '@/components/settings/Device/UsbConfigForm';
import { getUsbMouseOption } from '../UsbMouseModeSync';
import { useAppStore } from '@/stores';
import type { JsonRpcErrorResponse } from '@/api/rpc/types';

type JsonRpcCall = {
  method: string;
  params?: unknown;
};

type SendAsync = (
  call: JsonRpcCall,
  opts?: Record<string, unknown>
) => Promise<{ success: boolean; result?: unknown; error?: { message?: string; data?: string } }>;

type LoadingController = {
  start: (key: string) => void;
  stop: (key: string) => void;
};

type BacklightState = {
  max_brightness?: number;
  dim_after?: number;
  off_after?: number;
};

type SetDeviceSetting = (key: string, val: unknown) => void;

type DeviceApiContext = LoadingController & {
  isChannelReady: boolean;
  setDeviceSetting: SetDeviceSetting;
  backlightSettings: BacklightState;
  usbPreset: string;
  setUsbPreset: (val: string) => void;
  setUsbConfigState: (val: USBConfig) => void;
  setUsbIdentifierPreset: (val: string) => void;
  activeDeviceId: string | null;
  showUnhandledErrorToast?: boolean;
};

type UsbPreset = {
  labelKey: string;
  value: string;
  config?: UsbDeviceConfig;
};

type UsbIdentifierPreset = {
  labelKey: string;
  value: string;
  config?: USBConfig;
};

const LOADING_KEYS = [
  'setFileTransfer',
  'getFileTransfer',
  'getGuiSettings',
  'setBacklightSettings',
  'setDisplayRotation',
  'getUsbDevices',
  'setUsbDevices',
  'getUsbConfig',
  'setUsbConfig',
] as const;

const USB_PRESETS: UsbPreset[] = [
  {
    labelKey: 'settings:hardware.usb.devices.presets.fullFeatureSet',
    value: 'default',
    config: {
      keyboard: true,
      absolute_mouse: true,
      relative_mouse: true,
      mass_storage: true,
      microphone: true,
    },
  },
  {
    labelKey: 'settings:hardware.usb.devices.presets.keyboardMouse',
    value: 'keyboard_mouse',
    config: {
      keyboard: true,
      absolute_mouse: true,
      relative_mouse: true,
      mass_storage: false,
      microphone: false,
    },
  },
  {
    labelKey: 'settings:hardware.usb.devices.presets.keyboardOnly',
    value: 'keyboard_only',
    config: {
      keyboard: true,
      absolute_mouse: false,
      relative_mouse: false,
      mass_storage: false,
      microphone: false,
    },
  },
  {
    labelKey: 'settings:common.custom',
    value: 'custom',
  },
];

const USB_DEVICE_CONFIG_KEYS: (keyof UsbDeviceConfig)[] = [
  'absolute_mouse',
  'keyboard',
  'mass_storage',
  'relative_mouse',
  'microphone',
];

const USB_IDENTIFIER_PRESETS: UsbIdentifierPreset[] = [
  {
    labelKey: 'settings:hardware.usb.identifiers.presets.arkkvmDefault',
    value: 'USB Emulation Device',
    config: {
      vendor_id: '0x1d6b',
      product_id: '0x0104',
      serial_number: 'deviceId',
      manufacturer: 'ArkKVM',
      product: 'USB Emulation Device',
    },
  },
  {
    labelKey: 'settings:hardware.usb.identifiers.presets.logitechUniversalAdapter',
    value: 'Logitech USB Input Device',
    config: {
      vendor_id: '0x046d',
      product_id: '0xc52b',
      serial_number: 'generatedSerialNumber',
      manufacturer: 'Logitech (x64)',
      product: 'Logitech USB Input Device',
    },
  },
  {
    labelKey: 'settings:hardware.usb.identifiers.presets.microsoftWirelessKeyboard',
    value: 'Wireless MultiMedia Keyboard',
    config: {
      vendor_id: '0x045e',
      product_id: '0x005f',
      serial_number: 'generatedSerialNumber',
      manufacturer: 'Microsoft',
      product: 'Wireless MultiMedia Keyboard',
    },
  },
  {
    labelKey: 'settings:hardware.usb.identifiers.presets.dellMultimediaKeyboard',
    value: 'Multimedia Pro Keyboard',
    config: {
      vendor_id: '0x413c',
      product_id: '0x2011',
      serial_number: 'generatedSerialNumber',
      manufacturer: 'Dell Inc.',
      product: 'Multimedia Pro Keyboard',
    },
  },
  {
    labelKey: 'settings:common.custom',
    value: 'custom',
  },
];

const BRIGHTNESS_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '10', label: 'Low' },
  { value: '35', label: 'Medium' },
  { value: '64', label: 'High' },
];

const DIM_AFTER_OPTIONS = [
  { value: '0', label: 'Never' },
  { value: '60', label: '1 Minute' },
  { value: '300', label: '5 Minutes' },
  { value: '600', label: '10 Minutes' },
  { value: '1800', label: '30 Minutes' },
  { value: '3600', label: '1 Hour' },
];

const OFF_AFTER_OPTIONS = [
  { value: '0', label: 'Never' },
  { value: '300', label: '5 Minutes' },
  { value: '600', label: '10 Minutes' },
  { value: '1800', label: '30 Minutes' },
  { value: '3600', label: '1 Hour' },
];

function generateNumber(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function generateHex(min: number, max: number) {
  const len = generateNumber(min, max);
  const n = (Math.random() * 0xfffff * 1000000).toString(16);
  return n.slice(0, len);
}

function generateSerialNumber() {
  return [generateNumber(1, 9), generateHex(7, 7), 0, 1].join('&');
}

function getErrorMessage(error: unknown, fallback = 'Unknown error') {
  const e = error as Record<string, unknown> | null | undefined;
  return e?.data || e?.message || fallback;
}

type UsbConfigFieldErrors = Partial<Record<keyof USBConfig, string>>;

function validateUsbConfig(config: USBConfig): UsbConfigFieldErrors {
  const hexU16 = /^0x[0-9a-fA-F]{4}$/;
  const errors: UsbConfigFieldErrors = {};
  if (!hexU16.test(config.vendor_id)) {
    errors.vendor_id = 'Use format 0x0000.';
  }
  if (!hexU16.test(config.product_id)) {
    errors.product_id = 'Use format 0x0000.';
  }
  return errors;
}

function resolveUsbConfig(config: USBConfig, activeDeviceId: string | null): USBConfig {
  return {
    ...config,
    serial_number:
      config.serial_number === 'deviceId'
        ? activeDeviceId || ''
        : config.serial_number === 'generatedSerialNumber'
          ? generateSerialNumber()
          : config.serial_number,
  };
}

function isSameByKeys<T extends object>(
  keys: (keyof T)[],
  target: Partial<T> | undefined | null,
  source: Partial<T> | undefined | null
) {
  if (!target || !source) return false;
  return keys.every(key => target[key] === source[key]);
}

function findPresetByKeys<T extends object>(
  keys: (keyof T)[],
  target: Partial<T>,
  list: Array<{ config?: T }>
) {
  return list.find(item => isSameByKeys(keys, target, item.config));
}

function findPresetIndexByKeys<T extends object>(
  keys: (keyof T)[],
  target: Partial<T>,
  list: Array<{ config?: T }>
) {
  return list.findIndex(item => isSameByKeys(keys, target, item.config));
}

function useDeviceApi(ctx: DeviceApiContext) {
  const {
    start,
    stop,
    isChannelReady,
    setDeviceSetting,
    backlightSettings,
    usbPreset,
    setUsbPreset,
    setUsbConfigState,
    setUsbIdentifierPreset,
    activeDeviceId,
    showUnhandledErrorToast = true,
  } = ctx;

  const [, , sendAsync] = useJsonRpc();
  const send = sendAsync as SendAsync;

  const showError = useCallback(
    (message: string) => {
      if (showUnhandledErrorToast) toast.error(message);
    },
    [showUnhandledErrorToast]
  );

  const runWithLoading = useCallback(
    async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
      start(key);
      try {
        return await fn();
      } finally {
        stop(key);
      }
    },
    [start, stop]
  );

  const ensureChannelReady = useCallback(() => {
    if (isChannelReady) return true;
    toast.error('Channel not ready, please connect first');
    return false;
  }, [isChannelReady]);

  return useMemo(() => {
    const raw = {
      getGuiSettings: () => send({ method: 'getGuiSettings' }, { resultOnly: true }),
      getUsbConfig: () => send({ method: 'getUsbConfig' }, { resultOnly: true }),
      getUsbDevices: () => send({ method: 'getUsbDevices' }, { timeout: 10000, resultOnly: true }),
      getFileTransfer: () => send({ method: 'getFileTransfer' }, { resultOnly: true }),
      setBacklightSettings: (params: BacklightState) =>
        send({ method: 'setBacklightSettings', params }, { showUnhandledErrorToast: true }),
      setDisplayRotation: (rotation: string) =>
        send(
          { method: 'setDisplayRotation', params: { rotation } },
          { showUnhandledErrorToast: true }
        ),
      setFileTransfer: (enabled: boolean) =>
        send({ method: 'setFileTransfer', params: { enabled } }, { showUnhandledErrorToast: true }),
      setUsbDevices: (devices: UsbDeviceConfig) =>
        send(
          { method: 'setUsbDevices', params: { devices } },
          {
            showUnhandledErrorToast: true,
            // showUnhandledErrorToast: (_resp: JsonRpcErrorResponse) => {
            //   // const reasonKey = getErrorReasonKey(resp.error?.data as string, {
            //   //   segmentIndex: 1,
            //   // });

            //   // const t = i18n.getFixedT(i18n.language);
            //   return 'Cannot disable Virtual Storage while the Virtual USB Drive is mounted to the remote system. Mount it back to ArkKVM and try again. ';
            // },
          }
        ),
      setUsbConfig: (params: USBConfig) =>
        send({ method: 'setUsbConfig', params }, { showUnhandledErrorToast: true }),
    };

    return {
      getGuiSettings: () => runWithLoading('getGuiSettings', raw.getGuiSettings),

      getFileTransfer: () => runWithLoading('getFileTransfer', raw.getFileTransfer),

      setBacklightSettings: async (patch: Partial<BacklightState>) => {
        if (!ensureChannelReady()) return;

        const next = { ...backlightSettings, ...patch };
        setDeviceSetting('backlightSettings', next);

        await runWithLoading('setBacklightSettings', async () => {
          const { success } = await raw.setBacklightSettings(next);
          if (success) toast.success('Backlight settings updated');
        });
      },

      setDisplayRotation: async (rotation: string) => {
        if (!ensureChannelReady()) return;
        await runWithLoading('setDisplayRotation', async () => {
          const { success } = await raw.setDisplayRotation(rotation);
          if (success) {
            setDeviceSetting('displayRotation', rotation);
            toast.success('Display rotation updated');
          }
        });
      },

      getUsbDevices: async () => {
        if (!ensureChannelReady()) return null;

        try {
          const result = await runWithLoading('getUsbDevices', raw.getUsbDevices);
          if (!result) return null;

          const normalizedResult: UsbDeviceConfig = {
            ...defaultUsbDeviceConfig,
            ...result,
          };

          const presetIndex = findPresetIndexByKeys(
            USB_DEVICE_CONFIG_KEYS,
            normalizedResult,
            USB_PRESETS.filter(p => p.config) as Array<{
              config: UsbDeviceConfig;
            }>
          );

          const nextUsbPreset = USB_PRESETS[presetIndex]?.value || 'custom';
          setUsbPreset(nextUsbPreset);
          setDeviceSetting('usbPreset', nextUsbPreset);
          setDeviceSetting('usbDeviceConfig', normalizedResult);

          return result;
        } catch (e: unknown) {
          showError(`USB query failed: ${getErrorMessage(e)}`);
          return null;
        }
      },

      setUsbDevices: (devices: UsbDeviceConfig) =>
        runWithLoading('setUsbDevices', () => raw.setUsbDevices(devices)),

      getUsbConfig: async () => {
        if (!ensureChannelReady()) return null;

        try {
          const result = await runWithLoading('getUsbConfig', raw.getUsbConfig);
          if (!result) return;
          const matchedPreset = findPresetByKeys(
            ['manufacturer', 'product', 'product_id', 'vendor_id'],
            result,
            USB_IDENTIFIER_PRESETS.filter(p => p.config) as Array<{
              config: USBConfig;
            }>
          );

          const nextPreset = matchedPreset?.config?.product || 'custom';
          setUsbIdentifierPreset(nextPreset);
          setDeviceSetting('usbConfigProduct', nextPreset);
          setDeviceSetting('usbConfig', result);
          setUsbConfigState(result);

          return result;
        } catch (e: unknown) {
          showError(`Get USB config failed: ${getErrorMessage(e)}`);
          return null;
        }
      },

      setUsbConfig: async (config: USBConfig) => {
        if (!ensureChannelReady()) return;
        if (!config) {
          showError('USB config not found');
          return;
        }
        const validationErrors = validateUsbConfig(config);
        const firstError = Object.values(validationErrors)[0];
        if (firstError) {
          showError(firstError);
          return;
        }

        await runWithLoading('setUsbConfig', async () => {
          const speed = await sendAsync({ method: SETTINGS_RPC_METHODS.getUsbFullSpeed }, { showUnhandledErrorToast: true });
          if (!speed.success || typeof speed.result !== 'boolean') return;
          const nextConfig = { ...resolveUsbConfig(config, activeDeviceId), force_full_speed: speed.result };
          const resp = await raw.setUsbConfig(nextConfig);

          if (!resp.success) {
            showError(`Failed to update USB config: ${getErrorMessage(resp.error)}`);
            return;
          }

          setUsbConfigState(nextConfig);
          setDeviceSetting('usbConfig', nextConfig);
          toast.success('USB config updated successfully');
        });
      },

      setFileTransfer: async (enabled: boolean) => {
        if (!ensureChannelReady()) return { success: false };

        return runWithLoading('setFileTransfer', async () => {
          const resp = await raw.setFileTransfer(enabled);
          if ('error' in resp) {
            showError('Failed to update file transfer');
            return { success: false };
          }

          setDeviceSetting('fileTransfer', enabled);
          return { success: true };
        });
      },
    };
  }, [
    activeDeviceId,
    backlightSettings,
    ensureChannelReady,
    runWithLoading,
    send,
    setDeviceSetting,
    setUsbConfigState,
    setUsbIdentifierPreset,
    setUsbPreset,
    showError,
    usbPreset,
  ]);
}

export default function SettingDevice() {
  const { t } = useTranslation(['settings']);
  const [, isChannelReady, sendAsync] = useJsonRpc();
  const { info } = useConfirmDialog();

  const currentSettings = useActiveDeviceSettings();
  const backlightSettings = useActiveDeviceSettings(state => state.backlightSettings) ?? {
    max_brightness: 64,
    dim_after: 1800,
    off_after: 0,
  };
  const fileTransfer = useActiveDeviceSettings(state => state.fileTransfer);
  const { activeDeviceId } = useSettingsStore();
  const { setDeviceSetting, setNestedDeviceSetting } = useSettingsActions();

  const { is: isLoading, start, stop } = useLoadingMap([...LOADING_KEYS]);

  const [usbPreset, setUsbPreset] = useState<string>(currentSettings?.usbPreset || 'default');

  const [usbIdentifierPreset, setUsbIdentifierPreset] = useState<string>(
    currentSettings?.usbConfigProduct || 'USB Emulation Device'
  );

  const [usbDeviceConfig, setUsbDeviceConfig] = useState<UsbDeviceConfig>(
    currentSettings?.usbDeviceConfig ?? defaultUsbDeviceConfig
  );
  const mouseInputMode = useAppStore(s => s.mouseInputMode);
  const [usbConfigState, setUsbConfigState] = useState<USBConfig>({
    vendor_id: currentSettings?.usbConfig?.vendor_id ?? '',
    product_id: currentSettings?.usbConfig?.product_id ?? '',
    serial_number: currentSettings?.usbConfig?.serial_number ?? '',
    manufacturer: currentSettings?.usbConfig?.manufacturer ?? '',
    product: currentSettings?.usbConfig?.product ?? '',
  });
  const forwarding = useActiveDeviceSettings(s => s.sshForwarding) ?? false;
  const [usbReady, setUsbReady] = useState(false);
  const [usbBusy, setUsbBusy] = useState(false);
  const [fullSpeed, setFullSpeed] = useState<boolean | null>(null);
  const usbOperation = useRef(false);
  const usbGeneration = useRef(0);
  const showForwardingConflict = () => info({
    title: t('settings:advanced.forwarding.title'),
    content: t('settings:advanced.forwarding.blocked'),
    confirmText: t('settings:advanced.forwarding.ok'),
  });

  useEffect(() => {
    const generation = ++usbGeneration.current;
    setUsbReady(false);
    setFullSpeed(null);
    setUsbBusy(false);
    usbOperation.current = false;
    if (!isChannelReady || !activeDeviceId) return;
    void (async () => {
      const [settings, usb, speed] = await Promise.all([
        readForwardingSettings(sendAsync),
        sendAsync({ method: 'getUsbDevices' }, { showUnhandledErrorToast: true }),
        sendAsync({ method: SETTINGS_RPC_METHODS.getUsbFullSpeed }, { showUnhandledErrorToast: true }),
      ]);
      if (generation !== usbGeneration.current) return;
      if (speed.success && typeof speed.result === 'boolean') setFullSpeed(speed.result);
      const devices = usb.success ? parseUsbDevices(usb.result) : null;
      if (!settings || !devices || !devices.network_adapter || devices.network_adapter.enable !== settings.sshForwarding) {
        toast.error(t('settings:advanced.forwarding.usbUnavailable'));
        return;
      }
      const store = useSettingsStore.getState();
      store.setDeviceSettingById(activeDeviceId, 'mcpEnabled', settings.mcpEnabled);
      store.setDeviceSettingById(activeDeviceId, 'sshForwarding', settings.sshForwarding);
      store.setDeviceSettingById(activeDeviceId, 'usbDeviceConfig', devices);
      const preset = settings.sshForwarding ? 'custom' :
        USB_PRESETS.find(p => p.config && isSameByKeys(USB_DEVICE_CONFIG_KEYS, devices, p.config))?.value ?? 'custom';
      setUsbPreset(preset);
      store.setDeviceSettingById(activeDeviceId, 'usbPreset', preset);
      setUsbReady(true);
    })();
    return () => { ++usbGeneration.current; };
  }, [isChannelReady, activeDeviceId, sendAsync, t]);

  const handleFullSpeedChange = async (enabled: boolean) => {
    if (!isChannelReady || fullSpeed === null || usbOperation.current || isLoading('setUsbDevices') || isLoading('setUsbConfig')) return;
    usbOperation.current = true;
    setUsbBusy(true);
    const generation = usbGeneration.current;
    const response = await sendAsync({ method: SETTINGS_RPC_METHODS.setUsbFullSpeed, params: { enabled } }, { showUnhandledErrorToast: true });
    if (generation !== usbGeneration.current) return;
    if (response.success) setFullSpeed(enabled);
    usbOperation.current = false;
    setUsbBusy(false);
  };

  const deviceApi = useDeviceApi({
    start,
    stop,
    isChannelReady,
    setDeviceSetting: setDeviceSetting as SetDeviceSetting,
    backlightSettings,
    usbPreset,
    setUsbPreset,
    setUsbConfigState,
    setUsbIdentifierPreset,
    activeDeviceId,
  });
  const setMouseInputMode = useAppStore(s => s.setMouseInputMode);

  const deviceApiRef = useRef(deviceApi);
  deviceApiRef.current = deviceApi;

  const hasFetchedRef = useRef(false);
  const usbConfigFormRef = useRef<UsbConfigFormRef>(null);

  const orientation = currentSettings?.displayRotation ?? '90';

  const orientationOptions = useMemo(
    () => [
      {
        value: '270',
        label: t('settings:hardware.orientation.options.inverted'),
      },
      {
        value: '90',
        label: t('settings:hardware.orientation.options.normal'),
      },
    ],
    [t]
  );

  const usbOptions = useMemo(
    () =>
      USB_PRESETS.map(item => ({
        value: item.value,
        label: t(item.labelKey, item.value),
      })),
    [t]
  );

  const usbIdentifierOptions = useMemo(
    () =>
      USB_IDENTIFIER_PRESETS.map(item => ({
        value: item.value,
        label: t(item.labelKey, item.value),
      })),
    [t]
  );

  const canUseVirtualUsbDrive = Boolean(currentSettings?.usbDeviceConfig?.mass_storage);

  useEffect(() => {
    if (currentSettings?.usbDeviceConfig) {
      setUsbDeviceConfig(currentSettings.usbDeviceConfig);
    }
  }, [currentSettings?.usbDeviceConfig]);

  useEffect(() => {
    if (currentSettings?.usbConfig) {
      setUsbConfigState({
        vendor_id: currentSettings.usbConfig.vendor_id ?? '',
        product_id: currentSettings.usbConfig.product_id ?? '',
        serial_number: currentSettings.usbConfig.serial_number ?? '',
        manufacturer: currentSettings.usbConfig.manufacturer ?? '',
        product: currentSettings.usbConfig.product ?? '',
      });
    }
  }, [currentSettings?.usbConfig]);

  useEffect(() => {
    let cancelled = false;

    if (!isChannelReady) {
      hasFetchedRef.current = false;
      return;
    }

    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    void (async () => {
      try {
        const [guiSettings, fileTransferRes] = await Promise.all([
          deviceApiRef.current.getGuiSettings().catch(e => e),
          deviceApiRef.current.getFileTransfer().catch(e => e),
        ]);

        if (cancelled) return;

        setNestedDeviceSetting(prev => ({
          ...prev,
          backlightSettings: guiSettings,
          ...guiSettings,
          fileTransfer: fileTransferRes,
        }));
      } catch {
        // Keep the page usable even if one initialization request fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isChannelReady, setNestedDeviceSetting]);

  const handleUsbPresetChange = async (value: string, deviceConfig?: UsbDeviceConfig) => {
    if (!activeDeviceId || !isChannelReady || !usbReady || usbOperation.current || isLoading('setUsbDevices') || isLoading('setUsbConfig')) return;
    const modeChange = !deviceConfig;
    if (forwarding && modeChange) {
      showForwardingConflict();
      return;
    }
    usbOperation.current = true;
    setUsbBusy(true);
    const generation = usbGeneration.current;
    const current = () => generation === usbGeneration.current;
    try {
      // Recheck at commit time: presets and Restore Defaults cannot bypass forwarding constraints.
      const snapshot = await readUsbForwardingSnapshot(sendAsync);
      if (!current()) return;
      if (!snapshot) {
        setUsbReady(false);
        toast.error(t('settings:advanced.forwarding.usbUnavailable'));
        return;
      }
      useSettingsStore.getState().setDeviceSettingById(activeDeviceId, 'sshForwarding', snapshot.forwarding);
      if (snapshot.forwarding && (modeChange ||
          deviceConfig?.relative_mouse !== snapshot.devices.relative_mouse ||
          deviceConfig?.microphone !== snapshot.devices.microphone)) {
        showForwardingConflict();
        setUsbPreset('custom');
        useSettingsStore.getState().setDeviceSettingById(activeDeviceId, 'usbDeviceConfig', snapshot.devices);
        return;
      }
      if (value === 'custom' && !deviceConfig) {
        setUsbPreset(value);
        return;
      }
      const selected = deviceConfig && value === 'custom' ? deviceConfig : USB_PRESETS.find(p => p.value === value)?.config;
      if (!selected) return;
      // Keep the network adapter and unknown fields from the fresh device response.
      const devices: UsbDeviceConfig = { ...snapshot.devices, ...selected, network_adapter: snapshot.devices.network_adapter };
      const response = await deviceApi.setUsbDevices(devices);
      if (!current() || !response.success) return;
      toast.success(t('settings:hardware.usb.applied'));
      setUsbDeviceConfig(devices);
      setUsbPreset(snapshot.forwarding ? 'custom' : value);
      setDeviceSetting('usbDeviceConfig', devices);
      setDeviceSetting('usbPreset', snapshot.forwarding ? 'custom' : value);
      const mode = getUsbMouseOption(snapshot.forwarding ? { ...devices, relative_mouse: false } : devices);
      if (mode === 'none') {
        toast.warning(t('settings:mouse.inputMode.toast.noMouseDevice'));
        setMouseInputMode('none');
      } else if (mode === 'relative' && mouseInputMode !== 'relative') {
        toast.info(t('settings:mouse.inputMode.toast.changedToRelative'));
        setMouseInputMode('relative');
      } else if ((mode === 'absolute' || mode === 'both') && mouseInputMode !== 'absolute') {
        toast.info(t('settings:mouse.inputMode.toast.changedToAbsolute'));
        setMouseInputMode('absolute');
      }
    } finally {
      if (current()) {
        usbOperation.current = false;
        setUsbBusy(false);
      }
    }
  };

  const handleUsbIdentifierPresetChange = useCallback(
    (value?: string) => {
      const nextValue = value || USB_IDENTIFIER_PRESETS[0].value;
      setUsbIdentifierPreset(nextValue);
      setDeviceSetting('usbConfigProduct', nextValue);

      if (nextValue === 'custom') {
        const nextConfig = {
          ...defaultUsbConfig,
          serial_number: activeDeviceId || '',
        };
        setUsbConfigState(nextConfig);
        setDeviceSetting('usbConfig', nextConfig);
        return;
      }

      const selectedConfig = USB_IDENTIFIER_PRESETS.find(item => item.value === nextValue)?.config;

      if (!selectedConfig) return;

      const resolvedConfig = resolveUsbConfig(selectedConfig, activeDeviceId);
      setUsbConfigState(resolvedConfig);
      setDeviceSetting('usbConfig', resolvedConfig);
      void deviceApi.setUsbConfig(resolvedConfig);
    },
    [activeDeviceId, deviceApi, setDeviceSetting]
  );

  const handleUsbDeviceConfigChange = (config: UsbDeviceConfig) => {
    if (!usbReady || usbBusy) return;
    if (forwarding && (config.relative_mouse !== usbDeviceConfig.relative_mouse || config.microphone !== usbDeviceConfig.microphone)) {
      showForwardingConflict();
      return;
    }
    setUsbPreset('custom');
    setUsbDeviceConfig(config);
  };

  const handleUsbConfigStateChange = useCallback(
    (config: USBConfig) => {
      setUsbIdentifierPreset('custom');
      setDeviceSetting('usbConfigProduct', 'custom');
      setUsbConfigState(config);
      setDeviceSetting('usbConfig', config);
    },
    [setDeviceSetting]
  );

  const handleApplyUsbConfig = useCallback(async () => {
    const valid = await usbConfigFormRef.current?.validate();
    if (!valid) return;
    void deviceApi.setUsbConfig(usbConfigState);
  }, [deviceApi, usbConfigState]);

  const handleFileTransferChange = useCallback(
    async (enabled: boolean) => {
      const previous = fileTransfer;
      setDeviceSetting('fileTransfer', enabled);
      const result = await deviceApi.setFileTransfer(enabled);
      if (!result?.success) {
        setDeviceSetting('fileTransfer', previous);
      }
    },
    [deviceApi, fileTransfer, setDeviceSetting]
  );

  return (
    <SettingPageContainer
      title={t('settings:pages.hardware.title')}
      description={t('settings:pages.hardware.description')}
    >
      <SettingBlock
        title={t('settings:hardware.orientation.title')}
        content={t('settings:hardware.orientation.desc')}
      >
        <SettingBlock.Right>
          <Select
            value={orientation}
            size="xs"
            onChange={val => deviceApi.setDisplayRotation(val)}
            placeholder={t('settings:hardware.orientation.placeholder')}
            options={orientationOptions}
            disabled={!isChannelReady || isLoading('setDisplayRotation')}
          />
        </SettingBlock.Right>
      </SettingBlock>

      <SettingBlock
        title={t('settings:hardware.displayBrightness.title')}
        content={t('settings:hardware.displayBrightness.desc')}
      >
        <SettingBlock.Right>
          <Select
            value={String(backlightSettings.max_brightness)}
            size="xs"
            onChange={val => deviceApi.setBacklightSettings({ max_brightness: Number(val) })}
            placeholder={t('settings:hardware.displayBrightness.placeholder', 'Select brightness')}
            options={BRIGHTNESS_OPTIONS.map(o => ({
              ...o,
              label: t(`settings:hardware.displayBrightness.${o.label.toLowerCase()}`),
            }))}
            disabled={!isChannelReady || isLoading('setBacklightSettings')}
          />
        </SettingBlock.Right>
      </SettingBlock>

      <SettingBlock
        title={t('settings:hardware.dimAfter.title')}
        content={t('settings:hardware.dimAfter.desc')}
      >
        <SettingBlock.Right>
          <Select
            value={String(backlightSettings.dim_after)}
            size="xs"
            onChange={val => deviceApi.setBacklightSettings({ dim_after: Number(val) })}
            placeholder={t('settings:hardware.dimAfter.placeholder', 'Select dim timeout')}
            options={DIM_AFTER_OPTIONS.map(o => ({
              ...o,
              label:
                o.value === '0'
                  ? t('settings:hardware.dimAfter.never')
                  : o.value === '60'
                    ? t('settings:hardware.dimAfter.1minute')
                    : o.value === '300'
                      ? t('settings:hardware.dimAfter.5minutes')
                      : o.value === '600'
                        ? t('settings:hardware.dimAfter.10minutes')
                        : o.value === '1800'
                          ? t('settings:hardware.dimAfter.30minutes')
                          : t('settings:hardware.dimAfter.1hour'),
            }))}
            disabled={!isChannelReady || isLoading('setBacklightSettings')}
          />
        </SettingBlock.Right>
      </SettingBlock>

      <SettingBlock
        title={t('settings:hardware.turnOffAfter.title')}
        content={t('settings:hardware.turnOffAfter.desc')}
      >
        <SettingBlock.Right>
          <Select
            value={String(backlightSettings.off_after)}
            size="xs"
            onChange={val => deviceApi.setBacklightSettings({ off_after: Number(val) })}
            placeholder={t('settings:hardware.offAfter.placeholder', 'Select off timeout')}
            options={OFF_AFTER_OPTIONS.map(o => ({
              ...o,
              label:
                o.value === '0'
                  ? t('settings:hardware.turnOffAfter.never')
                  : o.value === '300'
                    ? t('settings:hardware.turnOffAfter.5minutes')
                    : o.value === '600'
                      ? t('settings:hardware.turnOffAfter.10minutes')
                      : o.value === '1800'
                        ? t('settings:hardware.turnOffAfter.30minutes')
                        : t('settings:hardware.turnOffAfter.1hour'),
            }))}
            disabled={!isChannelReady || isLoading('setBacklightSettings')}
          />
        </SettingBlock.Right>
        <SettingBlock.Bottom>
          <span className="text-sm">{t('settings:hardware.turnOffAfter.tip')}</span>
        </SettingBlock.Bottom>
      </SettingBlock>

      <SettingBlock
        title={t('settings:hardware.usb.title')}
        content={t('settings:hardware.usb.desc')}
      >
        <SettingBlock.Bottom className="ml-[20px]">
          <UsbDeviceSetting
            paddingBottom={10}
            title={t('settings:hardware.usb.classes.title')}
            content={t('settings:hardware.usb.classes.desc')}
            options={usbOptions}
            value={usbPreset}
            onChange={val => {
              handleUsbPresetChange(val);
            }}
            onUpdate={() => handleUsbPresetChange(usbPreset, usbDeviceConfig)}
            onRefresh={() => handleUsbPresetChange('default')}
            loading={isLoading('getUsbDevices')}
            saving={usbBusy || isLoading('setUsbDevices')}
            disabled={!isChannelReady || !usbReady || usbBusy || isLoading('setUsbDevices') || isLoading('setUsbConfig')}
          >
            <UsbDeviceSwitchGroup
              className="ml-[20px] mt-[10px]"
              value={usbDeviceConfig}
              onChange={handleUsbDeviceConfigChange}
              disabled={!isChannelReady || !usbReady || usbBusy || isLoading('setUsbDevices') || isLoading('setUsbConfig')}
              lockedDevices={forwarding ? ['relative_mouse', 'microphone'] : []}
              onLockedInteraction={showForwardingConflict}
              titleSize={10}
              contentSize={10}
            />
          </UsbDeviceSetting>

          <SettingBlock
            title={t('settings:hardware.usb.virtualUsbDrive.title')}
            content={t('settings:hardware.usb.virtualUsbDrive.desc')}
            titleSize={12}
            contentSize={10}
          >
            <SettingBlock.Right>
              <Switch
                checked={fileTransfer}
                onCheckedChange={handleFileTransferChange}
                disabled={
                  isLoading('setFileTransfer') ||
                  isLoading('getUsbDevices') ||
                  isLoading('setUsbDevices') ||
                  !isChannelReady || usbBusy ||
                  !canUseVirtualUsbDrive
                }
              />
            </SettingBlock.Right>
            <SettingBlock.Bottom>
              <span className="text-sm text-[#FB923C]">
                {t('settings:hardware.usb.virtualUsbDrive.warning')}
              </span>
            </SettingBlock.Bottom>
          </SettingBlock>

          <UsbDeviceSetting
            title={t('settings:hardware.usb.identifiers.title')}
            content={t('settings:hardware.usb.identifiers.desc')}
            options={usbIdentifierOptions}
            value={usbIdentifierPreset}
            onChange={handleUsbIdentifierPresetChange}
            onUpdate={handleApplyUsbConfig}
            onRefresh={() => handleUsbIdentifierPresetChange()}
            loading={isLoading('getUsbConfig')}
            saving={isLoading('setUsbConfig')}
            disabled={!isChannelReady || usbBusy || isLoading('setUsbDevices') || isLoading('setUsbConfig')}
          >
            <div className="ml mt">
              <UsbConfigForm
                ref={usbConfigFormRef}
                value={usbConfigState}
                onChange={handleUsbConfigStateChange}
                disabled={!isChannelReady || usbBusy || isLoading('setUsbDevices') || isLoading('setUsbConfig')}
              />
            </div>
          </UsbDeviceSetting>

          <SettingBlock title={t('settings:hardware.usb.fullSpeed.title')} content={t('settings:hardware.usb.fullSpeed.desc')} titleSize={12} contentSize={10}>
            <SettingBlock.Right>
              <Switch title={t('settings:hardware.usb.fullSpeed.warning')} aria-label={t('settings:hardware.usb.fullSpeed.title')} checked={fullSpeed ?? false}
                onCheckedChange={enabled => void handleFullSpeedChange(enabled)}
                disabled={!isChannelReady || fullSpeed === null || usbBusy || isLoading('setUsbDevices') || isLoading('setUsbConfig')} />
            </SettingBlock.Right>
          </SettingBlock>
        </SettingBlock.Bottom>
      </SettingBlock>
    </SettingPageContainer>
  );
}
