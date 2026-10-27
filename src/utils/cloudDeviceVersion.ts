/** Resolve the device-reported webVersion from getCurrentVersion. */
export function getCloudDeviceVersionUrl(href: string, deviceId: string, result: unknown): string | null {
  const url = new URL(href);
  const route = /^\/([^/]+)\/device\/([^/]+)\/?$/.exec(url.pathname);
  if (!route || route[2] !== deviceId) return null;
  if (typeof result !== 'object' || result === null || !('webVersion' in result) ||
      typeof result.webVersion !== 'string') return null;
  // showUI adds the display-only -dev tag; device non-UI versions omit it.
  const version = result.webVersion.trim().replace(/-dev$/, '');
  if (!/^\d+(?:\.\d+)+$/.test(version) || version === route[1]) return null;
  url.pathname = `/${version}/device/${route[2]}`;
  return url.href;
}
