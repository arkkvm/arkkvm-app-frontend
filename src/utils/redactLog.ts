/** Snapshot log values without exposing credentials or invoking object getters. */
const REDACTED = '[REDACTED]';
const sensitiveKey = (key: string) =>
  /(?:token|password|passwd|pwd|authorization|cookie|secret|apikey|privatekey|credentials)$/i.test(key.replace(/[^a-z0-9]/gi, ''));

function redactText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, `$1 ${REDACTED}`)
    .replace(/((?:https?:\/\/))[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/(["']?(?:[\w-]*token|password|passwd|pwd|authorization|proxy-authorization|cookie|set-cookie|[\w-]*secret|api[_-]?key|private[_-]?key|credentials)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s&,;\]}]+)/gi,
      `$1${REDACTED}`);
}

function entries(input: Headers | URLSearchParams | Map<unknown, unknown>): Array<[unknown, unknown]> {
  const result: Array<[unknown, unknown]> = [];
  input.forEach((entry: unknown, key: unknown) => {
    if (result.length < 100) result.push([key, entry]);
  });
  return result;
}

export function redactLog(value: unknown): unknown {
  const secrets = new Set<string>();
  const collected = new WeakSet<object>();
  const collect = (input: unknown, depth: number, sensitive = false): void => {
    if (typeof input === 'string') {
      if (sensitive && input) secrets.add(input);
      return;
    }
    if (!input || typeof input !== 'object' || depth > 8 || collected.has(input)) return;
    collected.add(input);
    try {
      if (input instanceof Headers || input instanceof URLSearchParams || input instanceof Map) {
        for (const [key, entry] of entries(input)) {
          collect(entry, depth + 1, sensitive || (typeof key === 'string' && sensitiveKey(key)));
        }
        return;
      }
      for (const key of Object.getOwnPropertyNames(input).slice(0, 100)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (descriptor && 'value' in descriptor) collect(descriptor.value, depth + 1, sensitive || sensitiveKey(key));
      }
    } catch { /* Uninspectable values are omitted below. */ }
  };
  collect(value, 0);
  const text = (input: string) => {
    let output = input;
    for (const secret of Array.from(secrets).sort((a, b) => b.length - a.length)) {
      output = output.split(secret).join(REDACTED);
    }
    return redactText(output);
  };
  const seen = new WeakSet<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return text(input);
    if (typeof input === 'function') return '[Function]';
    if (!input || typeof input !== 'object') return input;
    if (depth > 8) return '[Max depth]';
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    try {
      if (input instanceof Headers || input instanceof URLSearchParams || input instanceof Map) {
        return entries(input).map(([key, entry]) =>
          [visit(key, depth + 1), typeof key === 'string' && sensitiveKey(key) ? REDACTED : visit(entry, depth + 1)]);
      }
      if (input instanceof Set) return Array.from(input).slice(0, 100).map(entry => visit(entry, depth + 1));
      if (Array.isArray(input)) return input.slice(0, 100).map(entry => visit(entry, depth + 1));
      const result: Record<string, unknown> = Object.create(null);
      if (input instanceof Error) result.name = 'Error';
      for (const key of Object.getOwnPropertyNames(input).slice(0, 100)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        result[text(key)] = sensitiveKey(key) ? REDACTED
          : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Getter]';
      }
      return result;
    } catch {
      return '[Uninspectable]';
    }
  };
  return visit(value, 0);
}
