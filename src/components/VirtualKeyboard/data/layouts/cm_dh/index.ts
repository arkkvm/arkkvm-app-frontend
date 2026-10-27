/**
 * @Purpose: English Colemak-DH ANSI keyboard layout
 * @Author: colemak-dh contribution
 */
import type { LanguageLayoutModule } from '../types';
import { colemakDHMeta as meta } from '../meta';
import { winLayout } from './windows';
import { macLayout } from './mac';

/** English Colemak-DH ANSI layout module */
const colemakDH: LanguageLayoutModule = {
  meta,
  windows: winLayout,
  mac: macLayout,
};

export default colemakDH;
