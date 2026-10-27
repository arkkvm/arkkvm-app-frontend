import type { ControlState } from './control';
import type { GetVlanSettingsResponse } from './network';
import type {
  AddVirtualMediaItemParams,
  RemoveVirtualMediaItemParams,
  UpdateVirtualMediaListParams,
  VirtualMediaListResponse,
} from './media';
import type {
  RegisterTailscaleResponse,
  SwitchTailscaleParams,
  TailscaleStateResponse,
} from './tailscale';

export interface StorageFileInfo {
  createdAt: string; // ISO timestamp
  filename: string;
  size: number;
  totalBytes: number;
}

export interface ListStorageFilesResponse {
  files: StorageFileInfo[];
}

export type StorageCategoryId = 'system' | 'logs' | 'images' | 'targetOs' | 'userFiles';

export interface StorageDetailsCategory<T extends StorageCategoryId = StorageCategoryId> {
  id: T;
  label: string;
  bytesUsed: number;
  clearable: boolean;
}

export interface StorageDetailsResponse<T extends StorageCategoryId = StorageCategoryId> {
  bytesTotal: number;
  bytesUsed: number;
  bytesFree: number;
  categories: StorageDetailsCategory<T>[];
}

export type ArkKvmStorageDetailsResponse = StorageDetailsResponse<'system' | 'logs' | 'images'>;
export type FtStorageDetailsResponse = StorageDetailsResponse<'targetOs' | 'userFiles'>;

export interface LocalFileInfo {
  name: string;
  size: number;
  path: string;
}

export interface StartLocalFileDownloadResult {
  dataChannel: string;
}

export interface StartStorageFileUploadResponse {
  /** Server-confirmed bytes already received for this upload session. */
  alreadyUploadedBytes: number;
  /**
   * Upload channel identifier.
   * - WebRTC: data channel label string.
   * - HTTP device mode: upload id string.
   * - May be null when the server considers the upload complete.
   */
  dataChannel?: string | null;
}

export interface CloudStateResponse {
  connected: boolean;
  url: string;
  appUrl: string;
}

export type TLSMode = 'disabled' | 'self-signed' | 'custom';

export interface TLSStateResponse {
  mode: TLSMode;
  certificate?: string;
  privateKey?: string;
}

export interface TLSStateRequest {
  mode: TLSMode;
  certificate?: string;
  privateKey?: string;
}

export interface JigglerConfig {
  inactivity_limit_seconds: number;
  jitter_percentage: number;
  schedule_cron_tab: string;
  timezone?: string | null;
}

export interface MethodParamsMap {
  getMcpEnabled: void;
  setMcpEnabled: { enabled: boolean };
  getSshForwarding: void;
  setSshForwarding: { enabled: boolean };
  getUsbFullSpeed: void;
  setUsbFullSpeed: { enabled: boolean };
  takeOverControl: void;
  grantControl: { requestId: string };
  denyControl: { requestId: string };
  setAudioQuality: { factor: number };
  setAudioPlayback: { enabled: boolean };
  keyboardReport: { keys: number[]; modifier: number };
  relMouseReport: { dx: number; dy: number; buttons: number };
  absMouseReport: { x: number; y: number; buttons: number };
  wheelReport: { wheelY: number; wheelX?: number };
  getKeyboardLayout: void;
  setKeyboardLayout: { layout: string };
  getKeyboardLedState: void;
  getCameraEmulation: void;
  getMicrophoneEmulation: void;

  getVideoState: void;
  getUpdateStatus: void;
  getDeviceID: void;
  getCurrentVersion: { showUI?: boolean };
  getFileTransfer: void;
  getAutoUpdateState: void;
  getUiSwitch: void;
  getAudioPlayback: void;

  getCloudState: void;
  getTLSState: void;
  deregisterDevice: void;
  setCloudUrl: { apiUrl: string; appUrl: string };
  setTLSState: {
    state: TLSStateRequest;
  };
  mouseWheel: { deltaX: number; deltaY: number };
  mouseClick: { button: number };
  keyEvent: { type: 'keydown' | 'keyup'; key: string; keyCode: string };
  ping: void;
  reboot: { force?: boolean };
  getNetworkState: void;
  getNetworkSettings: void;
  setNetworkSettings: { settings: Record<string, unknown> };
  renewDHCPLease: void;
  getUSBState: void;
  unmountImage: void;
  rpcMountBuiltInImage: { filename: string };
  setJigglerState: { enabled: boolean };
  setJigglerConfig: JigglerConfig;
  getJigglerState: void;
  getJigglerConfig: void;
  sendWOLMagicPacket: { macAddress: string };
  getStreamQualityFactor: void;
  setStreamQualityFactor: { factor: number };
  setAutoUpdateState: { enabled: boolean };
  getEDID: void;
  setEDID: { edid: string };
  getDevChannelState: void;
  setDevChannelState: { enabled: boolean };
  tryUpdate: void;
  getDevModeState: void;
  setDevModeState: { enabled: boolean };
  getSSHKeyState: void;
  setSSHKeyState: { sshKey: string };
  setMassStorageMode: { mode: string };
  getMassStorageMode: void;
  isUpdatePending: void;
  getUsbEmulationState: void;
  setUsbEmulationState: { enabled: boolean };
  getUsbConfig: void;
  setUsbConfig: { usbConfig: Record<string, unknown> };
  checkMountUrl: { url: string };
  getVirtualMediaState: void;
  getVirtualMediaList: void;
  addVirtualMediaItem: AddVirtualMediaItemParams;
  removeVirtualMediaItem: RemoveVirtualMediaItemParams;
  updateVirtualMediaList: UpdateVirtualMediaListParams;
  getStorageSpace: void;
  getStorageDetails: void;
  clearStorageLogs: void;
  clearStorageImages: void;
  mountWithHTTP: { url: string; mode: string };
  mountWithWebRTC: { filename: string; size: number; mode: string };
  mountWithStorage: { filename: string; mode: string };
  listStorageFiles: void;
  deleteStorageFile: { filename: string };
  startStorageFileUpload: { filename: string; size: number };
  getWakeOnLanDevices: void;
  setWakeOnLanDevices: { params: Record<string, unknown> };
  resetConfig: void;
  facrotyReset: void;
  setDisplayRotation: { params: Record<string, unknown> };
  getDisplayRotation: void;
  setBacklightSettings: { params: Record<string, unknown> };
  getBacklightSettings: void;
  getDCPowerState: void;
  setDCPowerState: { enabled: boolean };
  setDCRestoreState: { state: Record<string, unknown> };
  getActiveExtension: void;
  setActiveExtension: { extensionId: string };
  getATXState: void;
  setATXPowerAction: { action: string };
  getSerialSettings: void;
  setSerialSettings: { settings: Record<string, unknown> };
  getUsbDevices: void;
  setUsbDevices: { devices: unknown[] | Record<string, unknown> };
  getKeyboardMacros: void;
  setKeyboardMacros: { params: Record<string, unknown> };
  getLocalLoopbackOnly: void;
  setLocalLoopbackOnly: { enabled: boolean };
  getVlanSettings: void;
  setVlanSettings: { settings: Record<string, unknown> };
  confirmVlanSettings: void;
  revertVlanSettings: void;
  getTailscaleState: void;
  switchTailscale: SwitchTailscaleParams;
  registerTailscale: void;
  registerTailscaleForce: void;
  collectEvidence: void;
  getLocalFileInfo: { path: string };
  startLocalFileDownload: { path: string; offset?: number };
  deleteCollectedEvidence: { path: string };
  startFtFsDownload: { path: string; name: string };
  getFtStorageDetails: void;
  clearFtUserFiles: void;
}
export type MethodName = keyof MethodParamsMap;
export interface MethodResultMap extends Record<MethodName, unknown> {
  getMcpEnabled: boolean;
  setMcpEnabled: null;
  setSshForwarding: null;
  getUsbFullSpeed: boolean;
  setUsbFullSpeed: null;
  getSshForwarding: boolean;
  takeOverControl: ControlState;
  grantControl: ControlState;
  denyControl: ControlState;
  getCloudState: CloudStateResponse;
  getDeviceID: string;
  getTLSState: TLSStateResponse;
  getTailscaleState: TailscaleStateResponse;
  switchTailscale: null;
  registerTailscale: RegisterTailscaleResponse;
  registerTailscaleForce: RegisterTailscaleResponse;
  getVlanSettings: GetVlanSettingsResponse;
  getJigglerState: boolean;
  getJigglerConfig: JigglerConfig;
  setJigglerState: null;
  setJigglerConfig: null;
  getVirtualMediaList: VirtualMediaListResponse;
  addVirtualMediaItem: null;
  removeVirtualMediaItem: null;
  updateVirtualMediaList: null;
  getStorageSpace: unknown; // TODO: add proper type
  getStorageDetails: ArkKvmStorageDetailsResponse;
  clearStorageLogs: null;
  clearStorageImages: null;
  listStorageFiles: ListStorageFilesResponse;
  deleteStorageFile: null;
  startStorageFileUpload: StartStorageFileUploadResponse | null;
  collectEvidence: string;
  getLocalFileInfo: LocalFileInfo;
  startLocalFileDownload: StartLocalFileDownloadResult;
  deleteCollectedEvidence: null;
  startFtFsDownload: { dataChannel: string };
  getFtStorageDetails: FtStorageDetailsResponse;
  clearFtUserFiles: null;
  setLocalLoopbackOnly: boolean;
  setSSHKeyState: null;
  getSSHKeyState: boolean;
  getDevModeState: { enabled: boolean };
}

export const SETTINGS_RPC_METHODS = {
  getMcpEnabled: 'getMcpEnabled',
  setMcpEnabled: 'setMcpEnabled',
  getSshForwarding: 'getSshForwarding',
  setSshForwarding: 'setSshForwarding',
  getUsbFullSpeed: 'getUsbFullSpeed',
  setUsbFullSpeed: 'setUsbFullSpeed',
} as const satisfies Record<string, MethodName>;
