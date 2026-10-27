import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require('typescript');
test('shared routes remain target-independent across builds and metadata updates', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkkvm-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'plugins/auto-routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const page = (file, meta) =>
    fs.writeFileSync(
      path.join(root, 'src/pages', file),
      `export const meta = ${JSON.stringify(meta)};\n`
    );
  page('viewer.page.tsx', { path: '/', cloudPath: '/:v/device/:id', target: 'universal' });
  page('setup.page.tsx', {
    path: '/devices/:id/set-name',
    cloudPath: '/devices/:id/set-name',
    target: 'universal',
  });
  page('setup.page_副本.tsx', { path: '/ignored-backup', target: 'universal' });
  page('local.page.tsx', { path: '/login-local', target: 'device' });
  page('cloud.page.tsx', { cloudPath: '/login', target: 'cloud' });
  const source = fs.readFileSync(
    path.join(repo, 'plugins/auto-routes/generateRoutesCore.ts'),
    'utf8'
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const output = path.join(root, 'src/router/routeConfig.ts');
  async function generate(target) {
    const exports = {};
    vm.runInNewContext(code, {
      exports,
      require,
      __dirname: path.join(root, 'plugins/auto-routes'),
      process: { env: { BUILD_TARGET: target } },
      console: {
        log() {},
        warn() {},
        error(...args) {
          throw Error(args.join(' '));
        },
      },
    });
    await exports.default();
    return fs.readFileSync(output, 'utf8');
  }
  function paths(code, target) {
    const compiled = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
      exports,
      require: name => {
        assert.equal(name, 'react');
        return { lazy: fn => fn };
      },
      process: { env: { BUILD_TARGET: target } },
    });
    return Array.from(exports.routes, r => r.path).sort();
  }
  const device = await generate('device');
  const before = fs.statSync(output).mtimeMs;
  const cloud = await generate('cloud');
  assert.equal(device, cloud, 'other-target generation must not change manifest');
  assert.equal(
    fs.statSync(output).mtimeMs,
    before,
    'unchanged routes must not trigger a file rewrite'
  );
  assert.deepEqual(paths(cloud, 'device'), ['/', '/devices/:id/set-name', '/login-local']);
  assert.deepEqual(paths(cloud, 'cloud'), ['/:v/device/:id', '/devices/:id/set-name', '/login']);
  page('local.page.tsx', { path: '/new-local/', target: 'device' });
  const changed = await generate('cloud');
  assert.notEqual(changed, cloud, 'metadata changes must update routes');
  assert.deepEqual(paths(changed, 'device'), ['/', '/devices/:id/set-name', '/new-local']);
  assert.deepEqual(paths(changed, 'cloud'), ['/:v/device/:id', '/devices/:id/set-name', '/login']);
});
