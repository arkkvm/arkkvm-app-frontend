import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConnectDevicePage from './connect.page';
import {
  beginCloudRegistrationContext,
  readCloudRegistrationContext,
  saveCloudRegistrationCredentials,
} from '@/utils/cloudRegistrationContext';

const m = vi.hoisted(() => ({
  props: null, getUserInfo: vi.fn(), logout: vi.fn(), navigate: vi.fn(),
  post: vi.fn(), remove: vi.fn(), replace: vi.fn(), t: key => key,
}));
const id = '990b8c482d2f6afb';
vi.mock('@/api', () => ({ request: { post: m.post, delete: m.remove } }));
vi.mock('@/stores', () => ({ useAppStore: selector => selector(m) }));
vi.mock('@/components/auth/ConnectDevice', () => ({ default: props => {
  m.props = props;
  return React.createElement('div');
} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: m.t }) }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => m.navigate,
  useParams: () => ({ id: '990b8c482d2f6afb' }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('@/utils/cloudRegistrationContext', async importOriginal => ({
  ...await importOriginal(), logCloudRegistration: vi.fn(),
}));

let root, host;
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const realWindow = window;
  vi.stubGlobal('window', new Proxy(realWindow, { get(target, key) {
    if (key === 'location') return { origin: 'https://app.example.com', replace: m.replace };
    return Reflect.get(target, key, target);
  } }));
  m.getUserInfo.mockResolvedValue({ id: 42, email: 'current@example.com', identities: [] });
  m.logout.mockResolvedValue(true);
  localStorage.setItem('token', 'current-login');
  beginCloudRegistrationContext({
    deviceId: id, deviceReturnTo: 'https://device.example.com/ad-login',
    firmwareVersion: '0.6.1', systemVersion: '0.6.2',
  });
  saveCloudRegistrationCredentials(id, {
    pairingToken: 'oauth-only-token', webToken: 'older-login', oidcGoogle: null, clientId: null,
  });
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(ConnectDevicePage)));
  expect(m.props.blocked).toBe(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.unstubAllGlobals();
});

it('waits for confirmation, prevents duplicate clicks, and hands off only the fresh token', async () => {
  let resolve;
  m.post.mockImplementation(() => new Promise(done => { resolve = done; }));
  let connecting;
  await act(async () => {
    connecting = m.props.onConnect();
    void m.props.onConnect();
    m.props.onSwitchAccount();
  });
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post).toHaveBeenCalledWith(`/devices/${id}/bind`, undefined, {
    timeout: 15000, headers: { Authorization: 'Bearer current-login' },
  });
  expect(m.replace).not.toHaveBeenCalled();
  expect(m.logout).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ success: true, data: { deviceId: id, tempToken: 'confirmed-token' } });
    await connecting;
  });
  const destination = new URL(m.replace.mock.calls[0][0]);
  expect(destination.origin).toBe('https://device.example.com');
  expect(destination.pathname).toBe('/ad-login');
  expect(destination.searchParams.get('token')).toBe('confirmed-token');
  expect(destination.searchParams.get('loginToken')).toBe('current-login');
  expect(readCloudRegistrationContext(id).pairingToken).toBe('confirmed-token');
  expect(m.remove).not.toHaveBeenCalled();
});

it.each([
  ['business failure', { success: false, data: null }],
  ['wrong device', { success: true, data: { deviceId: 'other', tempToken: 'bad' } }],
  ['empty credential', { success: true, data: { deviceId: id, tempToken: '' } }],
])('keeps the confirmation page on %s and allows retry', async (_name, response) => {
  m.post.mockResolvedValueOnce(response).mockResolvedValueOnce({ success: true, data: { deviceId: id, tempToken: 'retry-token' } });
  await act(async () => m.props.onConnect());
  expect(m.replace).not.toHaveBeenCalled();
  expect(m.props.error).toBe('deviceConnect.confirmationError');
  expect(m.props.blocked).toBe(false);
  expect(readCloudRegistrationContext(id).pairingToken).toBe('oauth-only-token');
  await act(async () => m.props.onConnect());
  expect(new URL(m.replace.mock.calls[0][0]).searchParams.get('token')).toBe('retry-token');
});

it('does not redirect on a network error or a missing current login', async () => {
  m.post.mockRejectedValueOnce(new Error('offline'));
  await act(async () => m.props.onConnect());
  expect(m.replace).not.toHaveBeenCalled();
  localStorage.removeItem('token');
  await act(async () => m.props.onConnect());
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.props.error).toBe('deviceConnect.confirmationError');
});

it('switches accounts without unbinding and clears old credentials while retaining device metadata', async () => {
  await act(async () => { m.props.onSwitchAccount(); });
  expect(m.remove).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect(m.logout).toHaveBeenCalledTimes(1);
  const login = new URL(m.logout.mock.calls[0][0], 'https://app.example.com');
  expect(login.pathname).toBe('/login');
  expect(login.searchParams.get('deviceId')).toBe(id);
  expect(login.searchParams.get('switchAccount')).toBe('1');
  const context = readCloudRegistrationContext(id);
  expect(context.pairingToken).toBeNull();
  expect(context.webToken).toBeNull();
  expect(context.name).toBe('arkkvm');
  expect(context.systemVersion).toBe('0.6.2');
  expect(context.deviceReturnTo).toBe('https://device.example.com/ad-login');
});
