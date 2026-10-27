/**
 * Colemak-DH ANSI shared letter mapping.
 *
 * Colemak-DH keeps every letter on the ANSI keyboard but moves it to a
 * different physical key. The table below maps each QWERTY physical key to the
 * character the remote host produces when its layout is set to Colemak-DH ANSI,
 * which is exactly what the HID report needs to type via "Paste Text".
 *
 * Layout diagram:
 *   q w f p b j l u y ;
 *   a r s t g m n e i o
 *   x c d v z k h , . /
 *
 * Non-letter keys (digits, symbols, modifiers) are inherited unchanged from the
 * US QWERTY layout, so only the entries below need maintaining.
 */
import type { KeyboardLayout, KeyDefinition } from '../../keyboard-types';

/** Physical QWERTY key -> character produced under Colemak-DH ANSI. */
export const COLEMAK_DH_LETTERS: Record<string, { base: string; shift: string }> = {
  // Top row
  KeyQ: { base: 'q', shift: 'Q' },
  KeyW: { base: 'w', shift: 'W' },
  KeyE: { base: 'f', shift: 'F' },
  KeyR: { base: 'p', shift: 'P' },
  KeyT: { base: 'b', shift: 'B' },
  KeyY: { base: 'j', shift: 'J' },
  KeyU: { base: 'l', shift: 'L' },
  KeyI: { base: 'u', shift: 'U' },
  KeyO: { base: 'y', shift: 'Y' },
  KeyP: { base: ';', shift: ':' },

  // Home row
  KeyA: { base: 'a', shift: 'A' },
  KeyS: { base: 'r', shift: 'R' },
  KeyD: { base: 's', shift: 'S' },
  KeyF: { base: 't', shift: 'T' },
  KeyG: { base: 'g', shift: 'G' },
  KeyH: { base: 'm', shift: 'M' },
  KeyJ: { base: 'n', shift: 'N' },
  KeyK: { base: 'e', shift: 'E' },
  KeyL: { base: 'i', shift: 'I' },
  Semicolon: { base: 'o', shift: 'O' },

  // Bottom row
  KeyZ: { base: 'z', shift: 'Z' },
  KeyX: { base: 'x', shift: 'X' },
  KeyC: { base: 'c', shift: 'C' },
  KeyV: { base: 'd', shift: 'D' },
  KeyB: { base: 'v', shift: 'V' },
  KeyN: { base: 'k', shift: 'K' },
  KeyM: { base: 'h', shift: 'H' },
};

/**
 * Clone a US QWERTY layout and replace the letters with their Colemak-DH
 * equivalents, keeping the original key geometry, symbols and modifier rows.
 */
export function toColemakDH(
  layout: KeyboardLayout,
  id: string,
  name: string
): KeyboardLayout {
  return {
    ...layout,
    id,
    name,
    rows: layout.rows.map(row =>
      row.map((key: KeyDefinition) => {
        const letters = COLEMAK_DH_LETTERS[key.keyCode];
        if (!letters) return key;
        return { ...key, legends: { ...key.legends, ...letters } };
      })
    ),
  };
}
