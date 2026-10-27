/**
 * Language keyboard layout registry.
 * Automatically collects and manages all language layouts.
 */

import type { KeyboardLayout } from './keyboard-types';

/** Keyboard layout standard */
export type KeyboardStandard = 'ansi' | 'iso' | 'jis';

/** Keyboard layout type */
export type LayoutType = 'qwerty' | 'qwertz' | 'azerty' | 'dvorak' | 'colemak';

/** Layout region */
export type LayoutRegion = 'global' | 'europe' | 'asia' | 'americas';

/** Layout metadata for generating options list */
export interface LayoutMeta {
  /** Unique identifier, e.g., "cs-CZ-qwerty" */
  id: string;
  /** Short tag, e.g., "CZ" */
  tag: string;
  /** Display name, e.g., "Czech - QWERTY" */
  name: string;
  /** Native language name, e.g., "Čeština" */
  nativeName: string;
  /** Layout type */
  layout: LayoutType;
  /** Keyboard standard */
  standard: KeyboardStandard;
  /** Region classification */
  region: LayoutRegion;
  /** Sort priority (lower number = higher priority) */
  priority: number;
  /** Whether recommended */
  recommended?: boolean;
  /** Whether supports AltGr functionality (default true)
   * - true: Supports AltGr, shows altGr characters when pressed
   * - false: No AltGr support, shows current input (e.g., US keyboard)
   */
  hasAltGr?: boolean;
  /** Additional notes */
  note?: string;
}

/**
 * Language layout module export structure.
 * Contains metadata and layout definitions for a specific language.
 */
export interface LanguageLayoutModule {
  /** Layout metadata */
  meta: LayoutMeta;
  /** Windows layout */
  windows?: KeyboardLayout;
  /** Mac layout */
  mac?: KeyboardLayout;
  /** Optional special characters function */
  getSpecialChars?(): LayoutChars;
}

/**
 * Layout option for UI selection.
 * Contains metadata and availability information for a specific layout.
 */
export type LayoutOption = LayoutMeta & {
  /** Whether has Windows layout */
  hasWindows: boolean;
  /** Whether has Mac layout */
  hasMac: boolean;
};

import csCZ from './layouts/cs_CZ';
import deCH from './layouts/de_CH';
import deDE from './layouts/de_DE';
import enGB from './layouts/en_GB';
import enUS from './layouts/en_US';
import colemakDH from './layouts/cm_dh';
import esES from './layouts/es_ES';
import frFR from './layouts/fr_FR';
import nlBE from './layouts/nl_BE';
import ptPT from './layouts/pt-PT';
import type { LayoutChars } from '../utils/generateCharMap';
// esEs esES

const ALL_LANGUAGE_LAYOUTS: LanguageLayoutModule[] = [
  enUS,
  enGB,
  colemakDH,
  csCZ,
  deCH,
  deDE,
  nlBE,
  frFR,
  esES,
  ptPT,
];

/** All layout metadata mapping (id -> meta) */
export const languageLayoutMetaMap: Record<string, LayoutMeta> = {};

/** All layout module mapping (id -> module) */
export const languageLayoutModuleMap: Record<string, LanguageLayoutModule> = {};

/** Language layout options list for UI selection */
export const languageLayoutOptions: LayoutOption[] = [];
ALL_LANGUAGE_LAYOUTS.forEach(module => {
  const { meta } = module;
  languageLayoutMetaMap[meta.id] = meta;
  languageLayoutModuleMap[meta.id] = module;
  languageLayoutOptions.push({
    ...meta,
    hasWindows: !!module.windows,
    hasMac: !!module.mac,
  });
});
languageLayoutOptions.sort((a, b) => a.priority - b.priority);

/**
 * Get layout metadata by language ID.
 */
export function getLanguageLayoutMeta(id: string): LayoutMeta | undefined {
  return languageLayoutMetaMap[id];
}

/**
 * Get layout module by language ID.
 */
export function getLanguageLayoutModule(id: string): LanguageLayoutModule | undefined {
  return languageLayoutModuleMap[id];
}

/**
 * Get keyboard layout by language ID and platform.
 */
export function getLanguageKeyboardLayout(
  id: string,
  platform: 'windows' | 'mac' = 'windows'
): KeyboardLayout | undefined {
  const module = languageLayoutModuleMap[id];
  if (!module) return undefined;
  return platform === 'mac' ? module.mac : module.windows;
}

/**
 * Get system language from browser.
 */
export function getSystemLanguage() {
  const langs = navigator.languages;
  return {
    primary: langs?.[0] || navigator.language || 'en-US',
    all: langs || [navigator.language || 'en-US'],
  };
}

/**
 * Match default keyboard layout by browser language.
 * @returns Matched keyboard layout ID, defaults to 'en-US-qwerty' if no match
 */
export function getDefaultKeyboardLayoutByLanguage(): string {
  const systemLang = getSystemLanguage();

  for (const lang of systemLang.all) {
    const normalizedLang = lang.toLowerCase();

    const exactMatch = languageLayoutOptions.find(option =>
      option.id.toLowerCase().startsWith(normalizedLang)
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  for (const lang of systemLang.all) {
    const langCode = lang.split('-')[0].toLowerCase();

    const langMatch = languageLayoutOptions.find(option =>
      option.id.toLowerCase().startsWith(langCode + '-')
    );
    if (langMatch) {
      return langMatch.id;
    }
  }

  return 'en-US-qwerty';
}

/**
 * Get special characters mapping for a specific language layout
 * @param layoutId - Layout ID (e.g., 'cs-CZ-qwerty')
 * @returns LayoutChars object with special character mappings, or empty object if not available
 */

export function getLanguageLayoutData(
  id: string,
  platform: 'windows' | 'mac' = 'windows'
): {
  layout: KeyboardLayout | undefined;
  specialChars: LayoutChars;
} {
  const module = languageLayoutModuleMap[id];
  if (!module) {
    return { layout: undefined, specialChars: {} };
  }

  const layout = platform === 'mac' ? module.mac : module.windows;
  const specialChars = module.getSpecialChars ? module.getSpecialChars() : {};

  return { layout, specialChars };
}

export function getLanguageSpecialChars(layoutId: string): LayoutChars {
  return getLanguageLayoutData(layoutId).specialChars;
}
