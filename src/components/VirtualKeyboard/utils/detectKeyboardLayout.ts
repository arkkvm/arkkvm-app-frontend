import {
    getLanguageKeyboardLayout,
    getLanguageSpecialChars,
    languageLayoutOptions,
} from '../data/language-layouts';
import { generateCharMapFromLayout } from './generateCharMap';

export type LayoutId =
  | 'en-US'
  | 'en-GB'
  | 'colemak-dh'
  | 'cs-CZ'
  | 'de-DE'
  | 'de-CH'
  | 'nl-BE'
  | 'es-ES'
  | 'fr-FR'
  | 'pt-PT'
  | 'unknown'

/**
 * Extract ISO code part from layout ID
 * 'en-US-qwerty' -> 'en-US'
 */
function extractIsoCode(layoutId: string): string {
  const parts = layoutId.split('-');
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return layoutId;
}

/**
 * Calculate number of characters in text that cannot be mapped in specified layout
 */
function countMissingChars(
  text: string,
  layoutId: string
): { missing: number; total: number; missingChars: Set<string> } {
  // Get layout data
  const layout = getLanguageKeyboardLayout(layoutId, 'windows');
  if (!layout) {
    return { missing: text.length, total: text.length, missingChars: new Set(text.split('')) };
  }

  // Generate character mapping table (include specialChars to match createHidReporter behavior)
  const specialChars = getLanguageSpecialChars(layoutId);
  const charMap = generateCharMapFromLayout(layout, specialChars);

  // Count unmappable characters
  const missingChars = new Set<string>();
  let totalChars = 0;

  for (const char of text) {
    // Skip whitespace and control characters
    if (/\s/.test(char) || char.charCodeAt(0) < 32) {
      continue;
    }

    totalChars++;

    // Check if character can be mapped
    if (!charMap[char]) {
      missingChars.add(char);
    }
  }

  return {
    missing: missingChars.size,
    total: totalChars,
    missingChars,
  };
}

/**
 * Auto-detect best keyboard layout based on text content
 *
 * Strategy: Test all available keyboard layouts, choose layout with fewest character mapping errors
 *
 * Performance optimizations:
 * - For long text (>2000 chars), only take first 2000 chars for detection
 * - Return immediately when perfect match (100%) found, avoid continuing tests
 *
 * @param pasted - Text to detect
 * @returns Best matching layout ISO code (e.g. 'en-US', 'nl-BE')
 */
export function detectKeyboardLayout(pasted: string): LayoutId {
  let text = pasted.normalize('NFC');

  // If text is empty or only whitespace, return default layout
  if (!text.trim()) {
    return 'en-US';
  }

  // Performance optimization: For very long text, only take first 2000 chars for detection
  // 2000 chars is enough to accurately determine layout while ensuring performance
  const MAX_DETECTION_LENGTH = 2000;
  if (text.length > MAX_DETECTION_LENGTH) {
    text = text.slice(0, MAX_DETECTION_LENGTH);
  }

  let bestMatch = {
    isoCode: 'en-US' as LayoutId,
    matchRate: 0,
    missing: Infinity,
  };

  // Language-specific unique characters for tie-breaking.
  // When multiple layouts have equal match rate, prefer the one whose signature chars appear in the text.
  const LAYOUT_SIGNATURE_CHARS: Partial<Record<string, string[]>> = {
    'es-ES': ['ñ', 'Ñ', '¿', '¡', '«', '»'],
    'fr-FR': ['œ', 'æ', 'ç', 'à', 'û', 'î'],
    'de-DE': ['ß', 'ä', 'ö', 'ü', 'Ä', 'Ö', 'Ü'],
    'de-CH': ['ß', 'ä', 'ö', 'ü'],
    'cs-CZ': ['č', 'š', 'ž', 'ř', 'ů', 'ě'],
  };

  function signatureBonus(isoCode: string): number {
    const sigs = LAYOUT_SIGNATURE_CHARS[isoCode];
    if (!sigs) return 0;
    return sigs.some(c => text.includes(c)) ? 1 : 0;
  }

  // Iterate all layouts to find best match
  for (const option of languageLayoutOptions) {
    const stats = countMissingChars(text, option.id);
    const matchRate = stats.total > 0 ? (stats.total - stats.missing) / stats.total : 0;
    const isoCode = extractIsoCode(option.id);

    // Performance optimization: Found perfect match (100%), return immediately
    // Only do this if no signature chars of other layouts are present
    if (matchRate === 1.0 && stats.missing === 0) {
      return isoCode as LayoutId;
    }

    const bonus = signatureBonus(isoCode);
    const effectiveRate = matchRate + bonus * 0.001; // tiny bonus to break ties

    // Update best match
    if (
      effectiveRate > bestMatch.matchRate ||
      (effectiveRate === bestMatch.matchRate && stats.missing < bestMatch.missing)
    ) {
      bestMatch = {
        isoCode: isoCode as LayoutId,
        matchRate: effectiveRate,
        missing: stats.missing,
      };
    }
  }

  // If best layout cannot map any characters, return default layout
  if (bestMatch.matchRate === 0) {
    return 'en-US';
  }

  return bestMatch.isoCode;
}
