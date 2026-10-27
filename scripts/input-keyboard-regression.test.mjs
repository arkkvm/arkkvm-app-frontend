import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = readFileSync(new URL('../src/hooks/useInputChannel.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('hook.ts', source, ts.ScriptTarget.Latest, true);
const withoutImports = ast.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(withoutImports, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function channel(bufferedAmount = 0) {
  return { readyState: 'open', bufferedAmount, sent: [],
    send(value) { this.sent.push(JSON.parse(value)); },
    addEventListener() {}, removeEventListener() {} };
}

function setup(reliable, unstable) {
  const exports = {};
  const bindings = {
    exports,
    useRTCStore: select => select({ inputChannel: reliable, inputUnstableChannel: unstable }),
    createLogger: () => ({ warn() {} }),
    useRef: current => ({ current }), useCallback: fn => fn,
    useMemo: fn => fn(), useEffect: fn => fn(),
    console: { log() {} },
  };
  new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
  return exports.useInputChannel();
}

test('Tab down and release use reliable channel even above mouse buffer limit', () => {
  const reliable = channel(300 * 1024), unstable = channel();
  const input = setup(reliable, unstable);
  input.sendKeyboardReport({ keys: [43, 0, 0, 0, 0, 0], modifier: 0 });
  input.sendKeyboardReport({ keys: [0, 0, 0, 0, 0, 0], modifier: 0 });
  assert.equal(reliable.sent.length, 2);
  assert.equal(reliable.sent[0].params.keys[0], 43);
  assert.deepEqual(reliable.sent[1].params.keys, [0, 0, 0, 0, 0, 0]);
  assert.equal(unstable.sent.length, 0);
});

test('keyboard never falls back to non-retransmitting channel when reliable channel is closed', () => {
  const reliable = channel(), unstable = channel();
  reliable.readyState = 'closed';
  setup(reliable, unstable).sendKeyboardReport({ keys: [43], modifier: 0 });
  assert.equal(reliable.sent.length, 0);
  assert.equal(unstable.sent.length, 0);
});

test('mouse routing and buffer protection remain unchanged', () => {
  const reliable = channel(), unstable = channel();
  const input = setup(reliable, unstable);
  input.sendAbsMouseReport({ x: 1, y: 2, buttons: 0 });
  assert.equal(unstable.sent.length, 1);
  unstable.bufferedAmount = 300 * 1024;
  input.sendAbsMouseReport({ x: 2, y: 3, buttons: 0 });
  assert.equal(unstable.sent.length, 1);
  assert.equal(reliable.sent.length, 0);
});

const page = readFileSync(new URL('../src/pages/devices/index.page.tsx', import.meta.url), 'utf8');
const start = page.indexOf('    const handleKeyDown = (event: KeyboardEvent) => {');
const end = page.indexOf('      const modifiersForReport =', start);
const keydown = ts.transpileModule(page.slice(start, end) + '\nreturn true; }; return handleKeyDown;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

class Element {
  constructor(tagName) { this.tagName = tagName; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
}

for (const [label, target, panelOpen, forwarded] of [
  ['remote screen', new Element('VIDEO'), false, true],
  ['local text input', new Element('INPUT'), false, false],
  ['open settings panel', new Element('VIDEO'), true, false],
]) {
  test(`non-fullscreen Tab focus handling: ${label}`, () => {
    let prevented = false;
    const handle = new Function('keyPressTimes', 'isAnyUiPanelOpen', 'HTMLElement', 'document', keydown)(
      new Map(), () => panelOpen, Element, { fullscreenElement: null },
    );
    const result = handle({ code: 'Tab', key: 'Tab', composedPath: () => [target],
      preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(prevented, forwarded);
    assert.equal(result === true, forwarded);
  });
}

const upStart = page.indexOf('    const handleKeyUp = (event: KeyboardEvent) => {');
const upEnd = page.indexOf('\n    // Clear all pressed keys', upStart);
const keyup = ts.transpileModule(page.slice(upStart, upEnd) + '\nreturn handleKeyUp;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function release({ code = 'KeyA', target = new Element('VIDEO'), count = 0, modifier = 0 } = {}) {
  const reliable = channel(), unstable = channel();
  const input = setup(reliable, unstable);
  const uiStates = [];
  const bindings = {
    HTMLElement: Element, resolveModifierCode: () => '',
    pressCountRef: { current: new Map([[code, count]]) },
    setPressedKey() {},
    isModifierKey: value => ['ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft'].includes(value),
    setVirtualKeyboardModifierState() {}, virtualKeyboardModifierState: {},
    externalModifierMask: () => modifier, modifierReleaseMode: 'auto',
    createInitialModifierState: () => ({}),
    setKeysDownState: state => uiStates.push(state), sendKeyboardReport: input.sendKeyboardReport,
  };
  const handle = new Function(...Object.keys(bindings), keyup)(...Object.values(bindings));
  handle({ code, composedPath: () => [target] });
  return { reliable, unstable, uiStates };
}

for (const code of ['KeyA', 'Tab', 'ArrowRight']) {
  test(`actual handleKeyUp sends ordinary release over reliable channel: ${code}`, () => {
    const result = release({ code });
    assert.equal(result.reliable.sent.length, 1);
    assert.deepEqual(result.reliable.sent[0].params, { keys: [0, 0, 0, 0, 0, 0], modifier: 0 });
    assert.equal(result.unstable.sent.length, 0);
  });
}

test('actual handleKeyUp clears a released modifier', () => {
  const result = release({ code: 'ShiftLeft', modifier: 2 });
  assert.equal(result.reliable.sent[0].params.modifier, 0);
});

test('ordinary key release preserves the supplied stored modifier mask', () => {
  const result = release({ modifier: 2 });
  assert.equal(result.reliable.sent[0].params.modifier, 2);
});

test('editable target preserves existing keyup filtering', () => {
  const result = release({ target: new Element('INPUT') });
  assert.equal(result.reliable.sent.length, 0);
  assert.equal(result.uiStates.length, 0);
});

test('release count threshold preserves existing keyup filtering', () => {
  const result = release({ count: 3 });
  assert.equal(result.reliable.sent.length, 0);
});
