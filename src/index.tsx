/**
 * @Purpose:
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-10-27 16:25:25
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-03-27 11:34:24
 */
/**
 * Application entry point.
 * Initializes logger, error handlers, mobile debug tools, and renders the React app.
 */
import 'animate.css';
import './autofill-override.css';
import './global.css';

import ReactDOM from 'react-dom/client';
import i18n from './i18n';
import { initializeCloudEnvironment } from './utils/env';
import { LogLevel, configureLogger, createLogger } from './utils/logger';
import { initMobileDebug } from './utils/mobileDebug';

// Browser translation mutates React-owned DOM; use the built-in language switcher.
document.documentElement.setAttribute('translate', 'no');
document.documentElement.classList.add('notranslate');

window.__arkkvm_debug__ = { configureLogger, LogLevel };

const logger = createLogger('App');
window.addEventListener('error', event => {
  if (
    event.error &&
    event.error.message &&
    event.error.message.includes('Extension context invalidated')
  ) {
    logger.warn('Browser extension context invalidated, ignoring error');
    event.preventDefault();
    return false;
  }
});

window.addEventListener('unhandledrejection', event => {
  if (
    event.reason &&
    event.reason.message &&
    event.reason.message.includes('Extension context invalidated')
  ) {
    logger.warn('Browser extension promise rejected, ignoring error');
    event.preventDefault();
  }
})

;(() => {
  if (typeof document === 'undefined') return;
  const name = 'viewport';
  let meta = document.querySelector(
    `meta[name="${name}"]`
  ) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', name);
    document.head.appendChild(meta);
  }
  const content =
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover';
  if (meta.content !== content) meta.setAttribute('content', content);
})();

initMobileDebug();

async function bootstrap() {
  const rootEl = document.getElementById('root');
  if (!rootEl) return;
  try {
    await initializeCloudEnvironment();
  } catch {
    console.error('[cloud-config] Cloud configuration is invalid; application startup stopped.');
    const message = document.createElement('p');
    message.setAttribute('role', 'alert');
    message.textContent = i18n.t('cloudConfig.error', { ns: 'common' });
    rootEl.replaceChildren(message);
    return;
  }
  const { default: App } = await import('./App');
  ReactDOM.createRoot(rootEl).render(<App />);
}
void bootstrap();
