import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/Upload/useUpload.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const handleUploadHttp = useCallback(');
const end = source.indexOf('\n  // ── WebRTC Upload Handler', start);
const body = ts.transpileModule(source.slice(start, end) + '\nreturn handleUploadHttp;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

async function upload(mode) {
  const size = 7 * 1024 ** 3;
  let accepted = 0;
  let posts = 0;
  let success = false;
  let failure = false;
  let lastProgress = 0;
  const file = { name: 'large.iso', size, slice: (a, b) => ({ size: b - a }) };
  const noop = () => {};
  const ref = current => ({ current });
  const context = {
    i18n: { t: key => key },
    useCallback: fn => fn, HTTP_CHUNK_SIZE: 500 * 1024 ** 2,
    setUploadState: state => { if (state === 'failed') failure = true; },
    httpAbortRef: ref(false), currentUploadedRef: ref(0), prev: ref(null),
    setUploadController: noop, removeUploadController: noop, unregisterUpload: noop,
    releaseUploadLock: noop, stopSpeedMeter: noop, updateUploadTask: noop,
    deleteUploadTask: noop, dequeueNextFile: () => null,
    onPause: noop, setCurrentUploadDetail: noop,
    onSuccessRef: ref(() => { success = true; }), onErrorRef: ref(noop),
    onProgressRef: ref(stats => {
      assert.ok(stats.transferredBytes >= lastProgress);
      assert.ok(stats.transferredBytes <= size);
      lastProgress = stats.transferredBytes;
    }),
    calculateTransferStats: (_, current) => ({ ...current,
      progress: current.transferredBytes / current.totalBytes * 100,
      speedBps: 1, speedFormatted: '1 B/s' }),
    logger: { info: noop, error: noop }, toast: { error: noop },
    sessionStorage: { getItem: () => '', setItem: noop },
    env: { apiBaseUrl: '' }, httpUploadUrl: '/storage/upload',
    startMethod: 'startStorageFileUpload', performance, setTimeout,
    sendAsync: async () => ({ success: true, result: {
      alreadyUploadedBytes: mode === 'stale' ? 0 : mode === 'ahead' ? accepted + 1 : accepted, dataChannel: 'upload_test',
    } }),
    XMLHttpRequest: class {
      upload = {};
      open() {}
      setRequestHeader() {}
      getResponseHeader() { return null; }
      send(blob) {
        posts++;
        assert.ok(posts <= 16, 'upload must terminate rather than loop');
        this.upload.onprogress?.({ loaded: blob.size, timeStamp: posts * 300 });
        const bytes = mode === 'stall' ? 0 : mode === 'partial' && posts === 1 ? blob.size / 2 : blob.size;
        accepted += bytes;
        this.status = mode === 'early200' ? 200 : mode === 'final202' ? 202 : accepted === size ? 200 : 202;
        this.responseText = mode === 'malformed' ? 'not json' : JSON.stringify({ message: `Upload partial: ${accepted}/${size}` });
        this.onload();
      }
    },
  };
  const handler = new Function(...Object.keys(context), body)(...Object.values(context));
  await handler(file, 0, 'upload_test');
  return { success, failure, accepted, posts, lastProgress, size };
}

test('7GiB HTTP upload completes only after device 200', async () => {
  const result = await upload('normal');
  assert.equal(result.success, true);
  assert.equal(result.accepted, result.size);
  assert.equal(result.posts, 15);
});
test('partial acceptance resumes from device offset', async () => {
  const result = await upload('partial');
  assert.equal(result.success, true);
  assert.equal(result.accepted, result.size);
  assert.equal(result.posts, 15);
});
for (const [mode, expectedPosts] of [['stale', 1], ['ahead', 1], ['stall', 1], ['malformed', 1], ['early200', 1], ['final202', 15]]) {
  test(`${mode} confirmation stops without success or repeated slices`, async () => {
    const result = await upload(mode);
    assert.equal(result.success, false);
    assert.equal(result.failure, true);
    assert.equal(result.posts, expectedPosts);
  });
}
