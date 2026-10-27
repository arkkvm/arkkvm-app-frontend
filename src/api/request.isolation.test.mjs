import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from './request';

vi.mock('@/utils/env', () => ({ env: { target: 'device', apiBaseUrl: 'http://device.test/api' } }));
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.setItem('token', 'device-token');
  sessionStorage.setItem('csrfToken', 'device-csrf');
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

it('isolates cloud credentials, cookies and CSRF response side effects', async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 1,
        success: true,
        data: { email: 'user@example.com' },
        csrfToken: 'cloud-body-csrf',
      }),
      {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'cloud-header-csrf' },
      }
    )
  );
  const result = await request.get('/me', {
    baseURL: 'https://cloud.example.com',
    credentials: 'include',
    headers: { Authorization: 'Bearer cloud-token' },
  });
  expect(result.success).toBe(true);
  const [url, config] = fetchMock.mock.calls[0];
  expect(url).toBe('https://cloud.example.com/me');
  expect(config.headers.get('Authorization')).toBe('Bearer cloud-token');
  expect(config.headers.has('X-CSRF-Token')).toBe(false);
  expect(config.credentials).toBe('omit');
  expect(config).not.toHaveProperty('baseURL');
  expect(localStorage.getItem('token')).toBe('device-token');
  expect(sessionStorage.getItem('csrfToken')).toBe('device-csrf');
});

it.each([401, 403])(
  'cloud HTTP %s does not clear the device session or redirect it',
  async status => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status, headers: { 'Content-Type': 'application/json' } })
    );
    const href = window.location.href;
    expect((await request.get('/me', { baseURL: 'https://cloud.example.com' })).success).toBe(
      false
    );
    expect(window.location.href).toBe(href);
    expect(localStorage.getItem('token')).toBe('device-token');
    expect(sessionStorage.getItem('csrfToken')).toBe('device-csrf');
    expect(fetchMock.mock.calls[0][1].headers.has('Authorization')).toBe(false);
  }
);

it('retains default same-app credentials and CSRF handling', async () => {
  fetchMock.mockResolvedValue(
    new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'new-device-csrf' },
    })
  );
  await request.get('/device');
  const [url, config] = fetchMock.mock.calls[0];
  expect(url).toBe('http://device.test/api/device');
  expect(config.headers.get('Authorization')).toBe('Bearer device-token');
  expect(config.headers.get('X-CSRF-Token')).toBe('device-csrf');
  expect(sessionStorage.getItem('csrfToken')).toBe('new-device-csrf');
});
