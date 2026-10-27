#!/usr/bin/env bash
set -euo pipefail

# Release orchestration; run.sh and Rsbuild own target configuration.
cd "$(dirname "${BASH_SOURCE[0]}")"

fail() {
  printf '[build.sh] ERROR: %s\n' "$1" >&2
  exit 1
}

show_usage() {
  cat <<'EOF'
Usage: ./build.sh [--version VERSION | --auto-version] [--target all|cloud|device] [--archive]

  --version VERSION  Use an exact version and create a versioned Cloud ZIP.
  --auto-version     Generate a version using the existing .env.pro history.
  --target TARGET    Build all (default), cloud, or device.
  --archive          Also ZIP an unversioned Cloud build; never ZIP Device.
  -h, --help         Show this help.

Outputs:
  Default:    dist/cloud/, dist/device/
  Versioned:  dist/VERSION/, dist/VERSION.zip, dist/device/, dist/version
  Only selected targets are replaced; other targets and versions are retained.
  Cloud always uses runtime configuration. DEVICE_BUILD_ENV=pro|test selects
  Device's existing configuration (default pro); it does not select a Cloud API.
EOF
}

build_target=all
release_version=''
auto_version=0
archive=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--version requires a value'
      [ -z "$release_version" ] || fail 'Duplicate --version'
      release_version="$2"
      shift 2
      ;;
    --auto-version)
      [ "$auto_version" -eq 0 ] || fail 'Duplicate --auto-version'
      auto_version=1
      shift
      ;;
    --target)
      [ "$#" -ge 2 ] || fail '--target requires a value'
      build_target="$2"
      shift 2
      ;;
    --archive) archive=1; shift ;;
    -h|--help) show_usage; exit 0 ;;
    *) fail "Unknown argument: $1 (see --help)" ;;
  esac
done

case "$build_target" in all|cloud|device) ;; *) fail 'Invalid --target' ;; esac
[ -z "$release_version" ] || [ "$auto_version" -eq 0 ] || fail '--version and --auto-version are mutually exclusive'
device_env="${DEVICE_BUILD_ENV:-pro}"
if [ "$build_target" != cloud ]; then
  case "$device_env" in pro|test) ;; *) fail 'DEVICE_BUILD_ENV must be pro or test' ;; esac
fi

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || fail "Invalid version: $1"
}

if [ -n "$release_version" ]; then validate_version "$release_version"; fi
if [ -n "$release_version" ] || [ "$auto_version" -eq 1 ]; then
  # Reuse the existing version generator, independently of Device's API config.
  VERSION='' node --import tsx scripts/generate-version.ts pro "$release_version"
  release_version="$(awk -F= '$1 == "RSB_APP_VERSION" { print $2 }' .env.pro)"
  validate_version "$release_version"
fi

cloud_name="${release_version:-cloud}"
if [ "$build_target" != device ] && { [ -n "$release_version" ] || [ "$archive" -eq 1 ]; }; then
  command -v zip >/dev/null 2>&1 || fail 'zip is required for the requested Cloud archive'
  archive=1
fi

mkdir -p dist
staging="$(mktemp -d "$PWD/dist/.build.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

targets=()
if [ "$build_target" != cloud ]; then targets+=(device); fi
if [ "$build_target" != device ]; then targets+=("$cloud_name"); fi

if [ "$build_target" != cloud ]; then
  ARKKVM_OUTPUT_DIR="$staging/device" ARKKVM_BUILD_VERSION="$release_version" \
    ./run.sh build device "$device_env"
fi
if [ "$build_target" != device ]; then
  cloud_mode=flat
  if [ -n "$release_version" ]; then cloud_mode=versioned; fi
  ARKKVM_OUTPUT_DIR="$staging/$cloud_name" ARKKVM_BUILD_VERSION="$release_version" \
    CLOUD_BUILD_MODE="$cloud_mode" ARKKVM_CLOUD_RUNTIME_ONLY=1 ./run.sh build cloud
fi

for name in "${targets[@]}"; do
  [ -s "$staging/$name/index.html" ] || fail "Missing $name/index.html"
  [ -n "$(find "$staging/$name" -type f -name '*.js' -print -quit)" ] || fail "Missing $name JavaScript assets"
done

if [ -n "$release_version" ]; then
  ARKKVM_DIST_ROOT="$staging" node --import tsx scripts/write-dist-version.ts pro
  [ "$(cat "$staging/version")" = "$release_version" ] || fail 'Invalid dist version file'
  for name in "${targets[@]}"; do
    [ "$(cat "$staging/$name/version")" = "$release_version" ] || fail "Invalid $name/version"
  done
fi

if [ "$archive" -eq 1 ] && [ "$build_target" != device ]; then
  # Create a fresh ZIP in staging; never update an old archive in place.
  (cd "$staging" && zip -rq "$cloud_name.zip" "$cloud_name")
  [ -s "$staging/$cloud_name.zip" ] || fail 'Cloud archive is missing or empty'
fi

# Publish only after all builds, metadata checks and archive creation succeed.
for name in "${targets[@]}"; do
  if [ -e "dist/$name" ]; then mv "dist/$name" "$staging/previous-$name"; fi
  if ! mv "$staging/$name" "dist/$name"; then
    if [ -e "$staging/previous-$name" ]; then mv "$staging/previous-$name" "dist/$name"; fi
    fail "Cannot publish $name"
  fi
  printf '[build.sh] Output: dist/%s/\n' "$name"
done
if [ -n "$release_version" ]; then mv "$staging/version" dist/version; fi
if [ "$archive" -eq 1 ] && [ "$build_target" != device ]; then
  mv "$staging/$cloud_name.zip" "dist/$cloud_name.zip"
  printf '[build.sh] Archive: dist/%s.zip\n' "$cloud_name"
fi
