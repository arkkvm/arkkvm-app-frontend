import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

vi.mock('@/utils/env', () => ({ env: { target: 'device', apiBaseUrl: '' } }));
vi.mock('@/utils/common', () => ({ normalizeUrl: (value) => value }));
vi.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal('window', { location: { pathname: '/', href: '/' } });
});

function response(body, token, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
  });
}

it('stores the login header before the next request and does not replace it with a different body token', async () => {
  const { request } = await import('../src/api/request');
  const fetch = vi.fn().mockResolvedValueOnce(response({ csrfToken: 'body-token' }, 'header-token'))
    .mockResolvedValueOnce(response({ deviceId: 'device' }));
  vi.stubGlobal('fetch', fetch);
  await request.post('/auth/login-local', { password: 'test' });
  await request.get('/device');
  expect(fetch.mock.calls[1][1].headers.get('X-CSRF-Token')).toBe('header-token');
});

it('an old delayed response body cannot overwrite a newly logged-in session', async () => {
  const { request } = await import('../src/api/request');
  sessionStorage.setItem('csrfToken', 'old-token');
  let finishBody;
  const old = response({});
  vi.spyOn(old, 'json').mockImplementation(() => new Promise(resolve => { finishBody = resolve; }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(response({ csrfToken: 'new-token' }, 'new-token')));
  const pending = request.get('/device');
  await vi.waitFor(() => expect(finishBody).toBeTypeOf('function'));
  await request.post('/auth/login-local', { password: 'test' });
  finishBody({ csrfToken: 'old-token' });
  await pending;
  expect(sessionStorage.getItem('csrfToken')).toBe('new-token');
});

it('a late 401 from before login cannot clear or redirect the new session', async () => {
  const { request } = await import('../src/api/request');
  sessionStorage.setItem('csrfToken', 'old-token');
  let finish;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response({ csrfToken: 'new-token' }, 'new-token')));
  const pending = request.get('/device');
  await request.post('/auth/login-local', { password: 'test' });
  finish(response({ error: 'Invalid or missing CSRF token' }, undefined, 401));
  expect((await pending).success).toBe(false);
  expect(sessionStorage.getItem('csrfToken')).toBe('new-token');
  expect(window.location.href).toBe('/');
});

it('a current 401 still clears the session and redirects', async () => {
  const { request } = await import('../src/api/request');
  sessionStorage.setItem('csrfToken', 'current-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, undefined, 401)));
  await request.get('/device');
  expect(sessionStorage.getItem('csrfToken')).toBeNull();
  expect(window.location.href).toBe('/login-local');
});

it('isolated APIs cannot write local CSRF or navigate the device page', async () => {
  const { request } = await import('../src/api/request');
  sessionStorage.setItem('csrfToken', 'device-token');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ csrfToken: 'remote-token' }, 'remote-token')));
  await request.post('/login', undefined, { baseURL: 'https://cloud.test' });
  expect(sessionStorage.getItem('csrfToken')).toBe('device-token');
});

it('body-only local CSRF remains supported', async () => {
  const { request } = await import('../src/api/request');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ csrfToken: 'body-only' })));
  await request.post('/auth/login-local', { password: 'test' });
  expect(sessionStorage.getItem('csrfToken')).toBe('body-only');
});

it('the latest login response installs its CSRF even if another writer changed storage while it was pending', async () => {
  const { request } = await import('../src/api/request');
  sessionStorage.setItem('csrfToken', 'old-token');
  let finish;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
  const pending = request.post('/auth/login-local', { password: 'test' });
  sessionStorage.setItem('csrfToken', 'late-upload-token');
  finish(response({ csrfToken: 'new-token' }, 'new-token'));
  await pending;
  expect(sessionStorage.getItem('csrfToken')).toBe('new-token');
});

it('a superseded login response cannot roll back the latest CSRF', async () => {
  const { request } = await import('../src/api/request');
  let finish;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response({ csrfToken: 'new-token' }, 'new-token')));
  const pending = request.post('/auth/login-local', { password: 'test' });
  await request.post('/auth/login-local', { password: 'test' });
  finish(response({ csrfToken: 'old-token' }, 'old-token'));
  await pending;
  expect(sessionStorage.getItem('csrfToken')).toBe('new-token');
});


it('a delayed upload response cannot replace the current device CSRF', () => {
  const source = readFileSync('src/components/Upload/useUpload.tsx', 'utf8');
  const ast = ts.createSourceFile('upload.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'xhr.onload') callback = node.right;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const code = ts.transpileModule(`let activeXhr; return (${callback.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const xhr = { getResponseHeader: () => 'late-token', status: 202, responseText: '{}' };
  const onload = new Function('xhr', 'env', 'sessionStorage', 'csrfToken', 'resolve', code)(
    xhr, { target: 'device' }, sessionStorage, 'old-token', () => {}
  );
  sessionStorage.setItem('csrfToken', 'new-token');
  onload();
  expect(sessionStorage.getItem('csrfToken')).toBe('new-token');
});
