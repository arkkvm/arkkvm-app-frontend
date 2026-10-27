import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'arkkvm-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'bin', 'dist/history', 'dist/device', 'dist/cloud']) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['build.sh', 'run.sh', 'cloud-regions.json', 'scripts/generate-version.ts', 'scripts/write-dist-version.ts']) copyFileSync(path.join(repo, file), path.join(root, file));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  writeFileSync(path.join(root, '.env.pro'), 'RSB_APP_VERSION=0.6.250101261\nRSB_API_BASE_URL_CLOUD=https://device-pro.example.com\n');
  writeFileSync(path.join(root, '.env.test'), 'RSB_APP_VERSION=0.6.25010101\nRSB_API_BASE_URL_CLOUD=https://device-test.example.com\n');
  for (const dir of ['history', 'device', 'cloud']) writeFileSync(path.join(root, `dist/${dir}/sentinel`), dir);
  writeFileSync(path.join(root, 'bin/pnpm'), `#!/usr/bin/env node
import fs from 'node:fs';
import p from 'node:path';
const e = process.env;
fs.appendFileSync('calls.jsonl', JSON.stringify({ target: e.BUILD_TARGET, mode: e.CLOUD_BUILD_MODE, runtime: e.ARKKVM_CLOUD_RUNTIME_ONLY, version: e.RSB_APP_VERSION, api: e.RSB_API_DOMAIN, app: e.RSB_APP_BASE_URL_CLOUD, apiCn: e.RSB_API_BASE_URL_CLOUD_CN, appCn: e.RSB_APP_BASE_URL_CLOUD_CN, env: e.RSB_TARGET_MODE }) + '\\n');
if (e.TEST_FAIL_TARGET === e.BUILD_TARGET) process.exit(23);
fs.mkdirSync(e.ARKKVM_OUTPUT_DIR, { recursive: true });
if (e.TEST_MISSING !== 'index') fs.writeFileSync(p.join(e.ARKKVM_OUTPUT_DIR, 'index.html'), '<html></html>');
if (e.TEST_MISSING !== 'js') fs.writeFileSync(p.join(e.ARKKVM_OUTPUT_DIR, 'index.js'), 'export {};');
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}` };
  for (const key of ['VERSION', 'DEVICE_BUILD_ENV', 'TEST_FAIL_TARGET', 'TEST_MISSING', 'ARKKVM_BUILD_VERSION', 'API_DOMAIN', 'APP_DOMAIN', 'API_DOMAIN_CN', 'APP_DOMAIN_CN', 'RSB_API_BASE_URL_CLOUD']) delete env[key];
  function run(args = [], overrides = {}) {
    return spawnSync('bash', ['build.sh', ...args], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000 });
  }
  return { root, run, calls: () => readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) };
}
function success(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

for (const tier of ['pro', 'test']) {
  test(`device ${tier} without endpoint variables includes both regions from the shared JSON`, t => {
    const f = fixture(t);
    writeFileSync(path.join(f.root, `.env.${tier}`), 'RSB_APP_VERSION=0.6.250101261\n');
    success(f.run(['--target', 'device'], { DEVICE_BUILD_ENV: tier }));
    const [device] = f.calls();
    const mapping = JSON.parse(readFileSync(path.join(f.root, 'cloud-regions.json'), 'utf8'));
    const regions = mapping[tier === 'pro' ? 'production' : 'test'];
    assert.equal(device.api, regions.global.apiUrl);
    assert.equal(device.app, regions.global.appUrl);
    assert.equal(device.apiCn, regions.china.apiUrl);
    assert.equal(device.appCn, regions.china.appUrl);
  });
}

test('explicit device region overrides take priority over env-file and JSON defaults', t => {
  const f = fixture(t);
  const overrides = {
    API_DOMAIN: 'https://override-api.example.com',
    APP_DOMAIN: 'https://override-app.example.com',
    API_DOMAIN_CN: 'https://cn-api.example.com',
    APP_DOMAIN_CN: 'https://cn-app.example.com',
  };
  success(f.run(['--target', 'device'], overrides));
  const [device] = f.calls();
  assert.equal(device.api, overrides.API_DOMAIN);
  assert.equal(device.app, overrides.APP_DOMAIN);
  assert.equal(device.apiCn, overrides.API_DOMAIN_CN);
  assert.equal(device.appCn, overrides.APP_DOMAIN_CN);
});

test('default builds flat runtime cloud and unchanged pro device, without ZIP/version writes', t => {
  const f = fixture(t); success(f.run());
  assert.deepEqual(f.calls().map(c => c.target), ['device', 'cloud']);
  const [device, cloud] = f.calls();
  assert.equal(device.api, 'https://device-pro.example.com');
  assert.equal(device.env, 'pro');
  assert.equal(cloud.api, ''); assert.equal(cloud.runtime, '1'); assert.equal(cloud.mode, 'flat');
  assert.ok(existsSync(path.join(f.root, 'dist/cloud/index.html')));
  assert.ok(existsSync(path.join(f.root, 'dist/device/index.html')));
  assert.ok(existsSync(path.join(f.root, 'dist/history/sentinel')));
  assert.ok(!existsSync(path.join(f.root, 'dist/version')));
  assert.ok(!existsSync(path.join(f.root, 'dist/cloud.zip')));
});

test('explicit version preserves release protocol and creates fresh ZIP with version directory', t => {
  const f = fixture(t), version = '0.6.261010263';
  success(f.run(['--version', version]));
  assert.ok(!existsSync(path.join(f.root, `dist/${version}/cloud`)));
  for (const file of ['version', 'device/version', `${version}/version`]) assert.equal(readFileSync(path.join(f.root, `dist/${file}`), 'utf8'), version);
  assert.ok(existsSync(path.join(f.root, 'dist/cloud/sentinel')));
  assert.ok(f.calls().every(c => c.version === version));
  const listing = spawnSync('unzip', ['-Z1', `dist/${version}.zip`], { cwd: f.root, encoding: 'utf8' });
  success(listing); assert.ok(listing.stdout.split('\n').filter(Boolean).every(n => n.startsWith(`${version}/`)));
  mkdirSync(path.join(f.root, `dist/${version}/old`));
  writeFileSync(path.join(f.root, `dist/${version}/old/removed.js`), 'old');
  spawnSync('zip', ['-q', `dist/${version}.zip`, `dist/${version}/old/removed.js`], { cwd: f.root });
  success(f.run(['--target', 'cloud', '--version', version]));
  const newListing = spawnSync('unzip', ['-Z1', `dist/${version}.zip`], { cwd: f.root, encoding: 'utf8' });
  assert.ok(!newListing.stdout.includes('removed.js'));
});

test('auto version reuses generation and increments three-digit same-day sequence', t => {
  const f = fixture(t), now = new Date();
  const date = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth()+1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  writeFileSync(path.join(f.root, '.env.pro'), `RSB_APP_VERSION=0.6.${date}261\n`);
  success(f.run(['--target', 'cloud', '--auto-version'], { VERSION: '9.9.9' }));
  const version = `0.6.${date}262`;
  assert.equal(readFileSync(path.join(f.root, 'dist/version'), 'utf8'), version);
  assert.ok(existsSync(path.join(f.root, `dist/${version}.zip`)));
  assert.ok(existsSync(path.join(f.root, 'dist/device/sentinel')));
});

test('device-only keeps test settings and does not touch cloud/history or ZIP', t => {
  const f = fixture(t); success(f.run(['--target', 'device', '--version', '1.2.3'], { DEVICE_BUILD_ENV: 'test' }));
  assert.equal(f.calls().length, 1); assert.equal(f.calls()[0].api, 'https://device-test.example.com');
  assert.equal(f.calls()[0].version, '1.2.3');
  assert.ok(existsSync(path.join(f.root, 'dist/cloud/sentinel')));
  assert.ok(!existsSync(path.join(f.root, 'dist/1.2.3')));
  assert.ok(!existsSync(path.join(f.root, 'dist/1.2.3.zip')));
});

test('cloud-only does not need pro/test API configuration', t => {
  const f = fixture(t);
  rmSync(path.join(f.root, '.env.pro')); rmSync(path.join(f.root, '.env.test'));
  success(f.run(['--target', 'cloud', '--archive'], { DEVICE_BUILD_ENV: 'unused' }));
  assert.equal(f.calls()[0].api, ''); assert.ok(existsSync(path.join(f.root, 'dist/cloud.zip')));
  assert.ok(existsSync(path.join(f.root, 'dist/device/sentinel')));
});

for (const args of [['--version', '1.2.3', '--auto-version'], ['--version'], ['--target'], ['--target', 'other'], ['--unknown'], ['--version', '../device'], ['test']]) {
  test(`rejects invalid arguments: ${args.join(' ')}`, t => {
    const f = fixture(t); assert.notEqual(f.run(args).status, 0);
    assert.ok(!existsSync(path.join(f.root, 'calls.jsonl')));
  });
}
for (const overrides of [{ TEST_FAIL_TARGET: 'cloud' }, { TEST_MISSING: 'index' }, { TEST_MISSING: 'js' }]) {
  test(`does not publish failed or missing outputs: ${JSON.stringify(overrides)}`, t => {
    const f = fixture(t); assert.notEqual(f.run([], overrides).status, 0);
    assert.ok(existsSync(path.join(f.root, 'dist/device/sentinel')));
    assert.ok(existsSync(path.join(f.root, 'dist/cloud/sentinel')));
    assert.ok(!readdirSync(path.join(f.root, 'dist')).some(n => n.startsWith('.build.')));
  });
}
test('ZIP failure is fatal and preserves existing outputs', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'bin/zip'), '#!/usr/bin/env bash\nexit 17\n', { mode: 0o755 });
  assert.notEqual(f.run(['--target', 'cloud', '--version', '1.2.3']).status, 0);
  assert.ok(!existsSync(path.join(f.root, 'dist/1.2.3')));
  assert.ok(existsSync(path.join(f.root, 'dist/cloud/sentinel')));
});
test('missing ZIP despite a successful archiver exit is fatal', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'bin/zip'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  assert.notEqual(f.run(['--target', 'cloud', '--version', '1.2.3']).status, 0);
  assert.ok(!existsSync(path.join(f.root, 'dist/1.2.3')));
});
test('metadata writer failure is fatal before publishing', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'scripts/write-dist-version.ts'), 'process.exit(19);');
  assert.notEqual(f.run(['--version', '1.2.3']).status, 0);
  assert.ok(existsSync(path.join(f.root, 'dist/device/sentinel')));
  assert.ok(!existsSync(path.join(f.root, 'dist/1.2.3')));
});
