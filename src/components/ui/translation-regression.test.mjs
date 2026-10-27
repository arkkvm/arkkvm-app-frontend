import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Button } from './button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';
import { ControlLeaseDialog } from '@/components/kvm/ControlLease/ControlLeaseDialog';
import SessionStatusBar from '@/components/kvm/SessionStatusBar';
import AuthLayout from '@/components/auth/AuthLayout';
import { MemoryRouter } from 'react-router-dom';
import { useAppStore } from '@/stores';
import i18n from '@/i18n';

vi.mock('@/hooks/useVideoRenderFps', () => ({ useVideoRenderFps: () => 60 }));
vi.mock('@/components', () => ({ WelcomeBackground: ({ title, subtitle, children }) =>
  React.createElement('main', null, React.createElement('h1', null, title),
    React.createElement('p', null, subtitle), children) }));
const h = React.createElement;
let root, host;
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage('en');
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useAppStore.getState().setAgentControlOwner(undefined);
  await i18n.changeLanguage('en');
});
const render = async node => act(async () => root.render(node));
// Model Chrome's important DOM mutation: detach React's text node and replace
// it with translated markup. This does not claim to run Chrome Translate itself.
function translate(target = document.body) {
  const walk = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walk.nextNode()) {
    const node = walk.currentNode;
    if (node.textContent.trim() && !node.parentElement.closest('[translate="no"], .notranslate, font')) nodes.push(node);
  }
  for (const node of nodes) {
    const translated = document.createElement('font'); translated.textContent = '中文译文';
    node.replaceWith(translated);
  }
  return nodes.length;
}

it('protects a conditional button label when translated text is removed beside a spinner', async () => {
  const button = (label, loading) => h(Button, { loading }, label);
  await render(button(i18n.t('login.logout'), false));
  expect(translate(host)).toBeGreaterThan(0);
  await render(button(null, true));
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  await render(button(i18n.t('login.logout'), false));
  expect(host.textContent).toContain(i18n.t('login.logout'));
});

it('keeps asChild semantics and existing element children intact', async () => {
  await render(h(Button, { asChild: true }, h('a', { href: '#test' }, h('span', null, i18n.t('login.logout')))));
  expect(host.querySelector('a > span')).not.toBeNull();
  expect(host.querySelector('button')).toBeNull();
});

it('keeps adjacent label pieces in one inline box to preserve flex spacing', async () => {
  await render(h(Button, null, i18n.t('login.logout'), ' ', 2));
  expect(host.querySelectorAll('button > span')).toHaveLength(1);
  expect(host.textContent).toBe(`${i18n.t('login.logout')} 2`);
});

it('updates device status and hides diagnostic rows after translation without touching technical identifiers', async () => {
  useAppStore.setState({ showDiagnosticInfo: true, showPressedKeys: true, showKeyboardLeds: true, agentControlOwner: 'agent' });
  await render(h(SessionStatusBar));
  expect(host.textContent).toContain('Agent State: Claude Code is active');
  const technical = [...host.querySelectorAll('[translate="no"]')];
  expect(technical.length).toBeGreaterThan(0);
  const before = technical.map(node => node.textContent);
  translate(host);
  expect(technical.map(node => node.textContent)).toEqual(before);
  await act(async () => useAppStore.setState({ hdmiConnectionState: 'no_signal', agentControlOwner: 'user' }));
  expect(host.textContent).toContain('no_signal');
  await act(async () => useAppStore.getState().setAgentControlOwner('user', 'takeOver'));
  expect(host.textContent).toContain('Agent State: Claude Code is view only');
  await act(async () => useAppStore.getState().setAgentControlOwner('user', 'ownerDisconnected'));
  await act(async () => useAppStore.setState({ showDiagnosticInfo: false, showPressedKeys: false, showKeyboardLeds: false }));
  expect(host.textContent).toContain(i18n.t('controlLease.statusNotControlling'));
});

it('opens, updates and closes the actual control dialog after translation', async () => {
  const dialog = prompt => h(ControlLeaseDialog, { prompt, busy: false, error: null, onAction: vi.fn(), onViewOnly: vi.fn() });
  await render(dialog({ kind: 'agent' }));
  expect(translate()).toBeGreaterThan(0);
  await render(dialog({ kind: 'request', requestId: 'request-1' }));
  translate();
  await render(dialog(null));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it('switches and closes a translated menu with icon/text siblings', async () => {
  const menu = (open, alternate) => h(DropdownMenu, { open },
    h(DropdownMenuTrigger, null, h('span', null, i18n.t('login.logout'))),
    h(DropdownMenuContent, null, h(DropdownMenuItem, null,
      h('svg', { 'aria-hidden': true }), alternate ? null : i18n.t('login.logout'))));
  await render(menu(true, false));
  expect(translate()).toBeGreaterThan(0);
  await render(menu(true, true));
  await render(menu(false, true));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it('submits a translated login form, switches provider presentation and renders logout without DOM errors', async () => {
  const submit = vi.fn(event => event.preventDefault());
  const page = (pending = false) => h(MemoryRouter, null, h(AuthLayout, {
    title: i18n.t('cloudLoginDirect.title'), action: i18n.t('login.logout'), onSubmit: submit, optionsPending: pending,
  }));
  await render(page());
  expect(translate(host)).toBeGreaterThan(0);
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(submit).toHaveBeenCalledOnce();
  await render(page(true));
  await render(h(Button, { onClick: submit }, i18n.t('login.logout')));
  translate(host);
  await act(async () => host.querySelector('button').click());
  await render(page());
});
