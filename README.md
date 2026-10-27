# ArkKVM Frontend

## Overview

ArkKVM Frontend is the web frontend for ArkKVM device and cloud workflows. It is not a complete standalone KVM system.

Full functionality depends on compatible ArkKVM device backend, cloud backend, firmware, signaling service, and device-side APIs. This repository focuses on the frontend application, development/build scripts, and frontend artifacts for deployment.

## Requirements

- Node.js `20.18.0`
- pnpm `10.11.1`

These versions match the repository Volta configuration.

## Quick Start

Install dependencies:

```bash
pnpm install
```

Start device development mode:

```bash
DEVICE_IP=<device-ip> pnpm dev
```

Start cloud development mode:

```bash
API_DOMAIN=https://api.example.com pnpm dev:cloud
```

Build Cloud and Device without generating a release version:

```bash
./build.sh
```

For a versioned Cloud release ZIP, use `./build.sh --version <version>` or `./build.sh --auto-version`. See [Build](#build).

## Development

Package scripts:

```bash
pnpm dev          # Start device development mode; requires DEVICE_IP
pnpm dev:cloud    # Start cloud development mode
pnpm build        # Build dist/cloud and dist/device; no automatic ZIP/version
pnpm build:test   # Same layout; Device uses .env.test, Cloud still uses runtime config
pnpm build:flat   # Compatibility alias for the default build
pnpm check        # Run ESLint (not TypeScript, tests, or build)
pnpm lint         # Run ESLint
pnpm lint:fix     # Run ESLint with fixes
```

`run.sh` starts development or builds a single target. Its `build` action does **not** generate a new version, write dist version files, or create/update ZIP archives:

```bash
./run.sh <action> <target> [env] [value]
```

- `action`: `dev` or `build`
- `target`: `device` or `cloud`
- `env`: `test` or `pro`, default `test`
- `value`:
  - `device`: device IP
  - `cloud`: cloud API domain

Examples:

```bash
./run.sh dev device test <device-ip>
DEVICE_IP=<device-ip> ./run.sh dev device
./run.sh dev cloud test https://api.example.com
API_DOMAIN=https://api.example.com ./run.sh dev cloud
```

Default dev URLs:

- Device dev: `http://localhost:9000`
- Cloud dev: `http://localhost:80`

Port `80` may require elevated permissions or local configuration changes.

## Build

Run from the repository root (or invoke build.sh by its path):

```bash
./build.sh
./build.sh --version 0.6.261010263
./build.sh --auto-version
```

| Command | Outputs |
| --- | --- |
| `./build.sh` | `dist/cloud/`, `dist/device/` |
| `./build.sh --version <version>` | `dist/<version>/`, `dist/<version>.zip`, `dist/device/`, `dist/version` |
| `./build.sh --auto-version` | Same versioned release layout, using the existing generator |
| `./build.sh --target cloud` | Only `dist/cloud/` |
| `./build.sh --target cloud --version <version>` | Only Cloud version directory/ZIP and `dist/version` |
| `./build.sh --target device` | Only `dist/device/` |
| `./build.sh --target device --version <version>` | `dist/device/` and its version file, plus `dist/version`; no Cloud ZIP |
| `./build.sh --target cloud --archive` | `dist/cloud/` and `dist/cloud.zip` |

`--target` defaults to `all`. `--version` and `--auto-version` are mutually exclusive. Old positional `pro`, `test`, and version arguments are rejected; use the named options. Versioned Cloud builds always create a ZIP; `--archive` additionally enables ZIP for unversioned Cloud builds and has no effect on Device-only builds.

### Complete release example

From the repository root, use Node.js 20.18.0+ and pnpm 10.11.1+. The following example installs locked dependencies, builds both targets with an automatic version, then checks the exact release artifacts. The subshell stops on failure so an older ZIP is not accidentally selected after a failed build.

```bash
(
  set -e
  pnpm install --frozen-lockfile

  # Generate the next release version and build Cloud + Device.
  ./build.sh --auto-version

  # Read the version produced by this successful build.
  release_version="$(cat dist/version)"
  test -s "dist/$release_version/index.html"
  test -s dist/device/index.html
  test "$(cat "dist/$release_version/version")" = "$release_version"
  test "$(cat dist/device/version)" = "$release_version"

  # Verify ZIP integrity and inspect its version-directory hierarchy.
  unzip -t "dist/$release_version.zip"
  unzip -l "dist/$release_version.zip"
  printf 'Upload this Cloud release: dist/%s.zip\n' "$release_version"
)
```

If the generated version is `0.6.261010264`, upload **`dist/0.6.261010264.zip`** in the cloud version-management page. The ZIP starts with `0.6.261010264/` and contains that release's `index.html`, `version`, `js/` and `static/`. Device artifacts remain in `dist/device/` and are not inside the Cloud ZIP. The version here is illustrative; automatic output depends on the build machine's date and `.env.pro` version history.

To use an exact version, replace the build line above with the following (choose an unused version):

```bash
./build.sh --version 0.6.261010263
```

For a Cloud-only release, replace it with `./build.sh --target cloud --auto-version` and omit the two Device checks. No API address arguments or `ARKKVM_CLOUD_RUNTIME_ONLY` flag are required. For example, when deployed at `https://app-tst.arkkvm.com`, missing runtime JSON falls back to `https://api-tst.arkkvm.com`; an unknown/self-hosted domain defaults to the current origin when runtime JSON is unavailable; provide valid site-root runtime JSON for a separate API origin. Uploading the ZIP does not itself configure server routing or CSP; after selecting/publishing the release, verify `/login`, its versioned assets, and `/oidc/providers` in the browser.

### Release layout and deployment

```text
dist/
├── <version>/
│   ├── index.html
│   ├── version
│   ├── js/
│   └── static/
├── <version>.zip
├── device/
│   ├── index.html
│   └── version
└── version
```

Cloud is never nested under `<version>/cloud/`. Device is always `dist/device/`. The Cloud ZIP contains only the selected `<version>/` directory, including that directory level; upload `dist/<version>.zip` to cloud version management. Versioned HTML references `/<version>/...`; the server must serve those paths and route `/login` to the selected entry. Unversioned Cloud uses root-relative assets and is deployed from `dist/cloud/`.

Only the selected target directories are replaced. Historical versions and unselected targets/archives are retained. A fresh ZIP is created in staging rather than updating an existing ZIP, preventing stale entries from previous builds. Invalid arguments, failed builds, missing HTML/JS outputs, metadata failures and ZIP failures return nonzero. Requested targets are built and checked before publishing; build/archive failure leaves existing published output directories intact.

### Versions and device compatibility

`--version` and `--auto-version` reuse `scripts/generate-version.ts`, then `scripts/write-dist-version.ts`. The shared release version record remains `RSB_APP_VERSION` in `.env.pro`; this is version history, not a Cloud API configuration dependency. Automatic versions preserve the first two components and use the local date `YYMMDD` plus a sequence starting at `01`; same-day sequences continue through `99 → 100` and `261 → 262`. A missing record defaults the prefix to `0.0`. Version generation updates the record before building, even if a later build fails.

Versioned builds write `dist/version`, the selected Cloud directory's `version`, and Device's `version` when Device is built. Default builds do not generate a new version or write these metadata files; normal package/env version values still apply inside bundles. An exported `VERSION` no longer implicitly changes build.sh output layout: use its explicit version options.

Device configuration continues through `run.sh`, defaulting to `.env.pro`. Use `DEVICE_BUILD_ENV=test ./build.sh` (or `pnpm build:test`) to retain Device's test configuration. A supplied release version overrides the embedded Device version, but Device API configuration is unchanged. Cloud always uses runtime configuration, independent of this device environment selection.

### Cloud runtime configuration

No address flags are needed with build.sh. It automatically enables `ARKKVM_CLOUD_RUNTIME_ONLY=1` for Cloud, clearing six injected API/App address values. It does not delete env files or omit bundled Switch destinations.

Production Cloud loads `/runtime-config.json` at the site root before loading App. The build does not generate or embed this optional file:

```json
{
  "apiBaseUrl": "https://api-tst.arkkvm.com",
  "appBaseUrl": "https://app-tst.arkkvm.com"
}
```

Both fields must be HTTP(S) origins without credentials, paths, queries or fragments. Valid JSON takes priority. Missing files, HTTP/network failure, the three-second configuration timeout, or HTML cause a warning and hostname fallback only for `^app(-tst)?\.arkkvm\.(com|cn)$`: replace the initial `app` with `api`, preserving protocol/port; app origin stays current. Invalid JSON or invalid fields stop startup. Unknown domains preserve explicit non-official self-hosted build configuration when available; otherwise API, login and signaling use the current origin (including protocol and port), without adding an /api prefix. Provide runtime JSON when the API uses a separate origin. Business API failures never change the selected address.

`cloud-regions.json` is the single source of official cloud region defaults for device binding, cloud region navigation, and `run.sh`. It groups `global` and `china` under `production` and `test`; each region explicitly defines `apiUrl` and `appUrl` as HTTP(S) origins without paths, credentials, queries, or fragments. `pro` selects `production`; `test` selects `test`. Test China currently uses the production China endpoints intentionally. Changing this bundled file requires rebuilding.

Existing build-time endpoint overrides still take priority over these defaults for device binding and development. Production cloud API resolution continues to use `runtime-config.json`, official hostname inference, and the existing self-hosted fallback; the region map does not override the current deployment's runtime API address. Custom device binding URLs remain supported. IP detection requires deployment CSP `connect-src` permission for `https://ipwho.is`. Server headers are not changed by building. Provider lookup uses the shared request timeout and retries once on failure.

### Lower-level builds and diagnostics

`run.sh` remains available for existing development and target-specific workflows:

```bash
./run.sh build device pro
./run.sh build device test
ARKKVM_CLOUD_RUNTIME_ONLY=1 CLOUD_BUILD_MODE=flat ./run.sh build cloud
```

These commands do not generate new versions, write dist version files, or create ZIPs. Cloud address injection is retained only for legacy run.sh workflows without runtime-only enabled; build.sh always uses runtime-only Cloud. Existing address arguments (`API_DOMAIN`, `APP_DOMAIN`, China counterparts and device IP) remain available for development/device configuration. The `example.com` fallback values are placeholders.

`DEBUG_RUN=1` prints script inputs; `DEBUG_BUILD=1` prints Rsbuild configuration. `ANALYZE=1` enables the existing bundle analyzer. These diagnostics do not disable production optimization. `CLOUD_BUILD_MODE` remains a low-level run.sh layout option; build.sh determines layout from its version flags and ignores inherited layout/address-policy switches.

Builds do not automatically run types, lint or tests. Build orchestration regression checks use Node's built-in test runner:

```bash
node --test scripts/build.test.mjs
```

Current package scripts do not define Desktop builds.

## Project Structure

```text
.
├── build.sh
├── run.sh
├── rsbuild.config.ts
├── postcss.config.mjs
├── scripts/
├── src/
│   ├── api/
│   ├── assets/
│   ├── components/
│   ├── contexts/
│   ├── hooks/
│   ├── i18n/
│   ├── pages/
│   ├── router/
│   ├── services/
│   ├── stores/
│   ├── styles/
│   ├── types/
│   ├── utils/
│   └── webrtc/
└── dist/
```

## Troubleshooting

### Device dev mode requires a device IP

Use either a positional value or `DEVICE_IP`:

```bash
./run.sh dev device test <device-ip>
DEVICE_IP=<device-ip> pnpm dev
```

### Cloud dev mode uses port 80

Cloud dev mode starts on `http://localhost:80`. Depending on your OS and shell, port `80` may require elevated permissions or local configuration changes.

### Node.js or pnpm version problems

Use the versions listed in Requirements:

```bash
node -v
pnpm -v
```

### WebRTC or device connection issues

Check that the relevant ArkKVM backend service is reachable and that the browser can access the device or cloud endpoint. Browser console logs, network logs, and WebRTC diagnostics are useful when reporting issues.

### Frontend-only runs have limited functionality

Starting this frontend alone does not make the full KVM workflow available. Device control, KVM streaming, media, USB, update, and cloud workflows require compatible backend and firmware support.

## Feedback and Security

Bug reports, feature requests, and documentation feedback can be submitted through Issues.

External pull requests are not accepted for this repository at this time.

Security vulnerabilities should not be reported through public Issues. Please follow the organization-level security reporting process.

## License

This project is licensed under the GNU General Public License v2.0 or later. See [LICENSE](./LICENSE).
