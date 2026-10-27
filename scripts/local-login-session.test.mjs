import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = readFileSync('src/pages/login-local.page.tsx', 'utf8');
const ast = ts.createSourceFile('login.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'onSubmit') callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule(`return (${callback.getText(ast)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(login, session) {
  const state = { posts: 0, gets: 0, redirects: [], errors: [], failures: 0, loading: false };
  const scope = {
    loginPendingRef: { current: false }, isAccountLocked: false, lockTimeRemaining: 0, attemptCount: 0,
    MAX_LOGIN_ATTEMPTS: 15, STORAGE_KEY_ATTEMPTS: 'attempts', STORAGE_KEY_LOCK_END: 'lock',
    t: key => key, form: { setError: (_, error) => state.errors.push(error.message) },
    request: {
      post: async () => { state.posts++; return await login; },
      get: async (path, config) => { state.gets++; assert.equal(path, '/device'); assert.equal(config.cache, 'no-store'); return session; },
    },
    handleLoginFailure: () => state.failures++,
    localStorage: { removeItem: () => {} }, setAttemptCount: () => {},
    setIsLoading: value => { state.loading = value; }, logger: { warn: () => {}, debug: () => {} },
    window: { location: { replace: path => state.redirects.push(path) } },
  };
  return { state, scope, submit: new Function(...Object.keys(scope), code)(...Object.values(scope)) };
}
test('only a verified session may leave the login page', async () => {
  const h = setup({ success: true }, { success: true });
  await h.submit({ password: 'test' });
  assert.deepEqual(h.state.redirects, ['/']); assert.equal(h.state.gets, 1);
  assert.equal(h.state.loading, false);
});
test('accepted password plus invalid session stays on login without increasing password failures', async () => {
  for (const code of [401, 0, 500]) {
    const h = setup({ success: true }, { success: false, code });
    await h.submit({ password: 'test' });
    assert.deepEqual(h.state.redirects, []);
    assert.deepEqual(h.state.errors, ['login.error.sessionUnavailable']);
    assert.equal(h.state.failures, 0);
  }
});
test('wrong passwords retain existing attempt tracking and skip session probe', async () => {
  const h = setup({ success: false, message: 'invalid' }, { success: true });
  await h.submit({ password: 'test' });
  assert.equal(h.state.failures, 1); assert.equal(h.state.gets, 0);
});
test('concurrent clicks cannot mint competing sessions', async () => {
  let resolve;
  const login = new Promise(done => { resolve = done; });
  const h = setup(login, { success: true });
  const first = h.submit({ password: 'test' });
  await h.submit({ password: 'test' });
  assert.equal(h.state.posts, 1);
  resolve({ success: true }); await first;
  assert.equal(h.state.gets, 1);
});
test('locked accounts never submit a password or probe a session', async () => {
  const h = setup({ success: true }, { success: true }); h.scope.isAccountLocked = true;
  const submit = new Function(...Object.keys(h.scope), code)(...Object.values(h.scope));
  await submit({ password: 'test' });
  assert.equal(h.state.posts, 0); assert.equal(h.state.gets, 0);
});
