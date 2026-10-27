import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync('src/pages/devices/connect.page.tsx', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let prepareNode;
let connectNode;
function visit(node) {
  if (!prepareNode && ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') {
    prepareNode = node.arguments[0];
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'connect') connectNode = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
function compile(node, context) {
  const code = ts.transpileModule(`return (${node.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), code)(...Object.values(context));
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(response) {
  const state = { flow: '', error: '', conflict: null, posts: 0, saves: 0, redirects: [] };
  const context = { pairingToken: 'oauth-token', deviceReturnTo: 'https://device.test/ad-login', name: 'device', systemVersion: '1' };
  const noop = () => {};
  const scope = {
    deviceId: 'abc', completing: false, attempt: 0, name: 'device', flow: 'confirm',
    nameSaved: { current: false }, completionContext: { current: null },
    preparedBinding: { current: null }, confirmationRequest: { current: null },
    submitLock: { current: false }, switchLock: { current: false },
    readCloudRegistrationContext: () => context,
    saveCloudRegistrationName: () => true,
    saveCloudRegistrationCredentials: () => { state.saves++; return true; },
    clearCloudRegistrationContext: noop, logCloudRegistration: noop,
    getUserInfo: async () => ({ displayName: 'user' }),
    localStorage: { getItem: () => 'web-token' },
    request: { post: async () => { state.posts++; return response; } },
    setName: noop, setSystemVersion: noop, setAccount: noop,
    setError: value => { state.error = value; },
    setFlow: value => { state.flow = value; },
    setBindingConflict: value => { state.conflict = value; },
    readDeviceBindingConflict: data => data?.reason === 'DEVICE_ALREADY_BOUND' ? { account: '', provider: '' } : null,
    t: key => key, navigate: noop, parseVersions: noop, URLSearchParams,
    window: { location: { replace: url => state.redirects.push(url) } },
  };
  return { state, scope, prepare: () => compile(prepareNode, scope)(), connect: () => compile(connectNode, scope)() };
}

test('prepares before showing Connect; click only hands off the confirmed credentials', async () => {
  const h = harness({ success: true, data: { deviceId: 'abc', tempToken: 'confirmed-token' } });
  h.prepare(); await flush();
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.flow, 'confirm');
  assert.equal(h.state.saves, 0);
  assert.equal(h.state.redirects.length, 0);
  await h.connect();
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.saves, 1);
  const url = new URL(h.state.redirects[0]);
  assert.equal(url.origin, 'https://device.test');
  assert.equal(url.searchParams.get('token'), 'confirmed-token');
});
test('bound conflict without account enters failure and never prepares handoff', async () => {
  const h = harness({ success: false, data: { reason: 'DEVICE_ALREADY_BOUND', boundAccount: null } });
  h.prepare(); await flush();
  assert.equal(h.state.flow, 'failed');
  assert.ok(h.state.conflict);
  assert.equal(h.scope.preparedBinding.current, null);
  h.scope.flow = 'failed'; await h.connect();
  assert.equal(h.state.redirects.length, 0);
});
test('malformed success cannot show Connect', async () => {
  for (const data of [{ deviceId: 'other', tempToken: 'token' }, { deviceId: 'abc' }]) {
    const h = harness({ success: true, data });
    h.prepare(); await flush();
    assert.equal(h.state.flow, 'failed');
    assert.equal(h.scope.preparedBinding.current, null);
  }
});
test('effect replay reuses confirmation; retry explicitly makes a new request', async () => {
  const h = harness({ success: true, data: { deviceId: 'abc', tempToken: 'token' } });
  const cleanup = h.prepare(); cleanup(); h.prepare(); await flush();
  assert.equal(h.state.posts, 1);
  h.scope.attempt++; h.prepare(); await flush();
  assert.equal(h.state.posts, 2);
});
test('cancelled page cannot activate Connect or hand off credentials', async () => {
  const h = harness({ success: true, data: { deviceId: 'abc', tempToken: 'token' } });
  const cleanup = h.prepare(); cleanup(); await flush();
  assert.equal(h.scope.preparedBinding.current, null);
  assert.notEqual(h.state.flow, 'confirm');
});
test('changed login session blocks the handoff without another bind request', async () => {
  const h = harness({ success: true, data: { deviceId: 'abc', tempToken: 'token' } });
  h.prepare(); await flush();
  h.scope.localStorage.getItem = () => 'different-session';
  await h.connect();
  assert.equal(h.state.flow, 'failed');
  assert.equal(h.state.posts, 1);
  assert.equal(h.state.redirects.length, 0);
});
