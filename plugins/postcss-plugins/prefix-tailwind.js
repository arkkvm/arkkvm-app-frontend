/**
 * @Purpose: PostCSS plugin - auto-prefix Tailwind utility classes
 * @Description: Adds a prefix to Tailwind-generated utility class selectors during PostCSS processing
 * @Author: zhanglei
 * @Date: 2025-07-18 18:15:00
 */

const DEFAULT_PREFIX = 'jg';

/**
 * Determine whether a selector contains class selectors
 */
function isTailwindClass(selector) {
  // Basic implementation: check for dot-based class selectors
  // Can be extended with stricter matching rules if needed
  return selector.includes('.');
}

/**
 * Check whether a selector already contains the configured prefix
 */
function hasPrefix(selector, prefix) {
  // Detect existing prefixed classes across common selector patterns
  return (
    selector.includes(`.${prefix}:`) ||
    selector.includes(`.${prefix}-`) ||
    selector.split(':').some(part => part.includes(`.${prefix}`))
  );
}

/**
 * Add prefix to class selectors
 */
function addPrefixToSelector(selector, prefix) {
  // Rewrite class selectors while preserving complex selector structure
  return selector.replace(/\.([-\w]+)/g, (match, className) => {
    // Skip class names that are already prefixed
    if (hasPrefix(match, prefix)) {
      return match;
    }
    // Add prefix to current class
    return `.${prefix}:${className}`;
  });
}

/**
 * Custom PostCSS plugin that prefixes Tailwind class selectors
 * Processes compiled CSS and ensures generated utility classes carry the configured prefix
 * Useful when class names are created dynamically and cannot be fully prefixed at source
 */
const postcssPlugin = (opts = {}) => {
  // Resolve plugin options
  const prefix = opts.prefix || DEFAULT_PREFIX;
  const debug = opts.debug || false;

  // Return PostCSS plugin implementation
  return {
    postcssPlugin: 'postcss-tailwind-prefix',

    // Process each CSS rule
    Rule(rule) {
      // Process class-selector rules only; skip at-rules/keyframes contexts
      if (!rule.selector || rule.selector.startsWith('@') || rule.parent && rule.parent.name === 'keyframes') {
        return;
      }

      // Rewrite class selectors within the selector list
      const modifiedSelectors = rule.selector.split(',')
        .map(selector => {
          // Apply prefixing only when selector contains class selectors
          if (isTailwindClass(selector)) {
            // Keep selector unchanged if already prefixed
            if (hasPrefix(selector, prefix)) {
              return selector;
            }

            // Prefix selector classes
            const prefixed = addPrefixToSelector(selector, prefix);
            if (debug) {
            }
            return prefixed;
          }
          return selector;
        })
        .join(',');

      // Update selector only when changed
      if (rule.selector !== modifiedSelectors) {
        rule.selector = modifiedSelectors;
      }
    },
  };
};

postcssPlugin.postcss = true; // Mark as a PostCSS plugin

export default postcssPlugin;
