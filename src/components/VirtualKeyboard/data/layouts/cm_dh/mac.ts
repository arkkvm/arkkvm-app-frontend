/**
 * Colemak-DH ANSI - macOS layout.
 * Derived from the US QWERTY layout with letter positions remapped.
 */
import type { KeyboardLayout } from '../../keyboard-types';
import { macLayout as US_MAC_LAYOUT } from '../en_US/mac';
import { colemakDHMeta as LAYOUT_META } from '../meta';
import { toColemakDH } from './common';

export const macLayout: KeyboardLayout = toColemakDH(
  US_MAC_LAYOUT,
  LAYOUT_META.id,
  LAYOUT_META.name
);
