import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ConnectDevice from './ConnectDevice';
import i18n from '@/i18n';

vi.mock('@/components', () => ({
  WelcomeBackground: ({ title, subtitle, children }) =>
    React.createElement(
      'main',
      null,
      React.createElement('h1', null, title),
      React.createElement('p', null, subtitle),
      children
    ),
}));
vi.mock('@/components/TopNavbar/TopNavbar', () => ({
  default: ({ account, showLinks }) =>
    React.createElement(
      'header',
      { 'data-show-links': String(showLinks) },
      'ArkKVM ',
      account?.email
    ),
}));
vi.mock('@/components/ui/copy-button', () => ({
  CopyButton: ({ text, label }) => React.createElement('button', { 'data-copy': text }, label),
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, 'aria-label': label }) =>
    React.createElement('button', { onClick, disabled, 'aria-label': label }, children),
}));
vi.mock('@/components/ui/input', () => ({
  Input: ({ value, onChange, disabled, 'aria-label': label }) =>
    React.createElement('input', { value, onChange, disabled, 'aria-label': label }),
}));
let root, host;
const defaults = {
  deviceId: '990b8c482d2f6afb',
  name: 'my-kvm',
  systemVersion: '0.6.1',
  account: { email: 'real@example.com', identities: [{ provider: 'github', email: null }] },
  loading: false,
  submitting: false,
  error: '',
  stage: 'confirm',
  onRetry: vi.fn(),
  onConnect: vi.fn(),
  onSaveName: vi.fn(),
};
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await i18n.changeLanguage('en');
});
const button = label =>
  [...host.querySelectorAll('button')].find(
    node => node.textContent === label || node.getAttribute('aria-label') === label
  );
async function render(props = {}) {
  await act(async () => root.render(React.createElement(ConnectDevice, { ...defaults, ...props })));
}
it('shows real account/device information, copy values, and English/Chinese labels', async () => {
  await render();
  expect(host.textContent).toContain('real@example.com');
  expect(host.textContent).toContain('Connect device');
  expect(host.querySelector('[data-copy="990b8c482d2f6afb"]')).not.toBeNull();
  expect(host.querySelector('[data-copy="0.6.1"]')).not.toBeNull();
  expect(host.textContent).toContain('real@example.com (GitHub)');
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('[data-slot="card"] dl').children).toHaveLength(3);
  expect(host.querySelector('header').textContent).toContain('real@example.com');
  expect(host.querySelector('header').textContent).toContain('ArkKVM');
  expect(host.querySelector('header').dataset.showLinks).toBe('false');
  await act(async () => i18n.changeLanguage('zh'));
  expect(host.textContent).toContain('连接设备');
  expect(host.textContent).toContain('设备名称');
});
it('editing blocks connect; failed save retains draft and cancel restores the original name', async () => {
  const save = vi.fn().mockResolvedValue(false);
  await render({ onSaveName: save });
  await act(async () => button('Edit device name').click());
  expect(button('Connect').disabled).toBe(true);
  const input = host.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
      input,
      'changed-name'
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Save').click());
  expect(save).toHaveBeenCalledWith('changed-name');
  expect(host.querySelector('input').value).toBe('changed-name');
  expect(host.querySelector('[role="alert"]').textContent).toContain('Could not save');
  await act(async () => button('Cancel').click());
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).toContain('my-kvm');
});
it('initialization and submission disable connect and show explicit loading status', async () => {
  await render({ loading: true });
  expect(button('Connect').disabled).toBe(true);
  expect(host.querySelector('[role="status"]').textContent).toContain('Loading');
  await render({ submitting: true });
  expect(button('Connecting…').disabled).toBe(true);
});

it('completion shows progress or a recoverable error without a second confirmation', async () => {
  await render({ stage: 'complete', submitting: true });
  expect(host.textContent).toContain('Completing setup');
  expect(host.textContent).not.toContain('Connect device');
  expect(button('Connect')).toBeUndefined();
  expect(button('Continue to Device')).toBeUndefined();
  expect(host.querySelector('dl')).toBeNull();
  await render({ stage: 'complete', error: 'Name could not be saved.' });
  expect(host.querySelector('[role="alert"]').textContent).toContain('Name could not be saved');
  expect(button('Retry')).toBeDefined();
});
it('a connection failure shows the device ID without offering another automatic connection', async () => {
  await render({ stage: 'failure', blocked: true, error: 'Already connected to another account.' });
  expect(host.textContent).toContain('Connection failed');
  expect(host.textContent).toContain('990b8c482d2f6afb');
  expect(button('Connect')).toBeUndefined();
  expect(button('Edit device name').disabled).toBe(true);
  expect(host.textContent).not.toContain('You’re about to connect');
});
it('successful connection stays on the result page until the dashboard link is clicked', async () => {
  const dashboard = vi.fn();
  await render({ stage: 'success', onDashboard: dashboard });
  expect(host.textContent).toContain('Connected successfully');
  expect(host.textContent).toContain('real@example.com');
  expect(host.querySelector('dl')).toBeNull();
  expect(button('Connect')).toBeUndefined();
  expect(dashboard).not.toHaveBeenCalled();
  await act(async () => button('Go to dashboard').click());
  expect(dashboard).toHaveBeenCalledTimes(1);
});
it('a saved draft returns to read-only display and explains when the cloud name is saved', async () => {
  await render({ onSaveName: vi.fn().mockResolvedValue(true) });
  await act(async () => button('Edit device name').click());
  expect(host.textContent).toContain('when you connect');
  await act(async () => button('Save').click());
  expect(host.querySelector('input')).toBeNull();
  expect(button('Connect').disabled).toBe(false);
});

it('uses a page-local dark theme and the established background token for the information card', async () => {
  const original = document.documentElement.className;
  await render();
  expect(host.querySelector('.dark')).not.toBeNull();
  expect(host.querySelector('[data-slot="card"]').className).toContain('bg-(--bg-secondary)');
  expect(document.documentElement.className).toBe(original);
});
