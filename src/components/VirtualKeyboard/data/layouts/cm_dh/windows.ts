/**
 * Colemak-DH ANSI - Windows layout.
 * Derived from the US QWERTY layout with letter positions remapped.
 */
import type { KeyboardLayout } from '../../keyboard-types';
import { US_WIN_LAYOUT } from '../en_US/windows';
import { colemakDHMeta as LAYOUT_META } from '../meta';
import { toColemakDH } from './common';

export const winLayout: KeyboardLayout = toColemakDH(
  US_WIN_LAYOUT,
  LAYOUT_META.id,
  LAYOUT_META.name
);
