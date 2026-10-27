import type { LayoutMeta } from './types';

export const enUSMeta: LayoutMeta = {
  id: 'en-US-qwerty',
  tag: 'US',
  name: 'US English – QWERTY',
  nativeName: 'English (United States)',
  layout: 'qwerty',
  standard: 'ansi',
  region: 'americas',
  priority: 1,
  recommended: true,
  hasAltGr: false,
  note: 'Recommended for KVM / BIOS / CLI',
};

export const enGBMeta: LayoutMeta = {
  id: 'en-GB-qwerty',
  tag: 'GB',
  name: 'UK English – QWERTY',
  nativeName: 'English (United Kingdom)',
  layout: 'qwerty',
  standard: 'iso',
  region: 'europe',
  priority: 2,
  recommended: true,
  hasAltGr: true,
  note: 'UK ISO layout',
};

export const colemakDHMeta: LayoutMeta = {
  id: 'colemak-dh',
  tag: 'DH',
  name: 'English (Colemak-DH ANSI)',
  nativeName: 'English (Colemak-DH ANSI)',
  layout: 'colemak',
  standard: 'ansi',
  region: 'americas',
  priority: 3,
  recommended: false,
  hasAltGr: false,
  note: 'Colemak-DH ANSI layout',
};

export const csCZMeta: LayoutMeta = {
  id: 'cs-CZ-qwerty',
  tag: 'CZ',
  name: 'Czech – QWERTY',
  nativeName: 'Čeština (Česko)',
  layout: 'qwerty',
  standard: 'iso',
  region: 'europe',
  priority: 11,
  hasAltGr: true,
};

export const deDEMeta: LayoutMeta = {
  id: 'de-DE-qwertz',
  tag: 'DE',
  name: 'German – QWERTZ',
  nativeName: 'Deutsch (Deutschland)',
  layout: 'qwertz',
  standard: 'iso',
  region: 'europe',
  priority: 12,
  hasAltGr: true,
};

export const deCHMeta: LayoutMeta = {
  id: 'de-CH-qwertz',
  tag: 'CHDE',
  name: 'Swiss German – QWERTZ',
  nativeName: 'Deutsch (Schweiz)',
  layout: 'qwertz',
  standard: 'iso',
  region: 'europe',
  priority: 13,
  hasAltGr: true,
};

export const ptPTMeta: LayoutMeta = {
  id: 'pt-PT-qwerty',
  tag: 'PT',
  name: 'Portuguese (Portugal)',
  nativeName: 'Português (Portugal)',
  layout: 'qwerty',
  standard: 'iso',
  region: 'europe',
  priority: 14,
  recommended: true,
  hasAltGr: true,
};

export const esESMeta: LayoutMeta = {
  id: 'es-ES-qwerty',
  tag: 'ES',
  name: 'Spanish (Spain)',
  nativeName: 'Español (España)',
  layout: 'qwerty',
  standard: 'iso',
  region: 'europe',
  priority: 15,
  recommended: true,
  hasAltGr: true,
};

export const frFRMeta: LayoutMeta = {
  id: 'fr-FR-azerty',
  tag: 'FR',
  name: 'French (France)',
  nativeName: 'Français (France)',
  layout: 'azerty',
  standard: 'iso',
  region: 'europe',
  priority: 15,
  recommended: true,
  hasAltGr: true,
};

export const nlBEMeta: LayoutMeta = {
  id: 'nl-BE-azerty',
  tag: 'BE',
  name: 'Dutch (Belgium)',
  nativeName: 'Nederlands (België)',
  layout: 'azerty',
  standard: 'iso',
  region: 'europe',
  priority: 15,
  recommended: false,
  hasAltGr: true,
};

export const layoutMetas = [
  enUSMeta,
  enGBMeta,
  colemakDHMeta,
  csCZMeta,
  deDEMeta,
  deCHMeta,
  ptPTMeta,
  esESMeta,
  frFRMeta,
  nlBEMeta,
] as const;
