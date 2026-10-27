import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

function load(file, require = () => { throw new Error('Unexpected import'); }) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function('exports', 'require', outputText)(exports, require);
  return exports;
}
const { getCloudDeviceVersionUrl: resolve } = load('../src/utils/cloudDeviceVersion.ts');
const href = 'https://app-tst.arkkvm.com/0.2.260708113/device/abc?deviceName=test&returnTo=%2Fdevices%2Flist#settings';
const result = webVersion => ({ appVersion: '9.9.9-dev', systemVersion: '8.8.8', webVersion });

test('uses device webVersion and preserves origin, device, query and hash', () => {
  assert.equal(resolve(href, 'abc', result('0.6.261020281-dev')),
    href.replace('0.2.260708113', '0.6.261020281'));
});
test('matching version never reloads, including after redirect', () => {
  assert.equal(resolve(href, 'abc', result('0.2.260708113-dev')), null);
  const next = resolve(href, 'abc', result('0.6.261020281'));
  assert.equal(resolve(next, 'abc', result('0.6.261020281-dev')), null);
});
test('refresh on local v-default resolves the device version', () => {
  assert.equal(resolve('http://localhost/v-default/device/abc?deviceName=test', 'abc', result('0.6.261020281-dev')),
    'http://localhost/0.6.261020281/device/abc?deviceName=test');
});
test('missing, malformed and unsafe metadata never redirect or use appVersion', () => {
  for (const version of [null, undefined, {}, '', 'v-default', '../login', '//evil.test', '1.2/../../login', '1.2-beta']) {
    assert.equal(resolve(href, 'abc', result(version)), null);
  }
  for (const value of [null, {}, [], { appVersion: '1.2' }, { error: 'timeout' }]) {
    assert.equal(resolve(href, 'abc', value), null);
  }
});
test('unversioned routes and device mismatch stay unchanged', () => {
  for (const path of ['/devices/list', '/device/abc', '/']) {
    assert.equal(resolve(`https://app.arkkvm.com${path}`, 'abc', result('1.2')), null);
  }
  assert.equal(resolve(href, 'other', result('1.2')), null);
});
