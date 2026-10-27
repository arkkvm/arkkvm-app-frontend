/**
 * Firmware capability gating for the cloud login page (doc 14 §4,
 * auth-analysis/05 §2.4).
 *
 * The device webapp appends `fw=<firmware version>` when it jumps to the
 * cloud login page during adoption. That parameter ships with the firmware
 * bundle, so it is a trustworthy capability statement; legacy webapps never
 * send it.
 */

/**
 * Minimum firmware version whose device-side register flow works for
 * non-Google accounts (de-providerized firmware, stage B).
 *
 * The first webapp that emits `fw` at all ships inside the stage-B firmware
 * bundle, so "fw present" already implies capability — the constant exists
 * so the gate can be tightened later without code changes if a specific
 * firmware cut turns out to need excluding. Update at stage-B release.
 */
export const MULTI_PROVIDER_MIN_FIRMWARE = '0.0.0';

const VERSION_PARTS = 3;

function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .slice(0, VERSION_PARTS)
    .map(part => Number(part) || 0);
}

/** Numeric-aware `a >= b` for dotted versions (patch may be 8-9 digits). */
export function firmwareVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = parseVersion(version);
  const b = parseVersion(min);
  for (let i = 0; i < VERSION_PARTS; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** True when the pairing path may offer non-Google providers. */
export function firmwareSupportsMultiProvider(fw: string | null | undefined): boolean {
  return firmwareVersionAtLeast(fw, MULTI_PROVIDER_MIN_FIRMWARE);
}
