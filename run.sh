#!/usr/bin/env bash
set -euo pipefail

# ArkKVM unified dev/build script.
# Usage: ./run.sh <action> <target> [env] [value]

log_info() {
  printf '[run.sh] %s\n' "$1"
}

log_error() {
  printf '[run.sh] ERROR: %s\n' "$1" >&2
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    log_error "Node.js not found. Required version: 20.18.0 or newer."
    exit 127
  fi

  if ! node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit(maj > 20 || (maj === 20 && min >= 18) ? 0 : 1)"; then
    log_error "Node.js 20.18.0 or newer is required. Current: $(node -v)"
    exit 1
  fi
}

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
  else
    log_error "pnpm not found. Install pnpm or enable Corepack."
    exit 127
  fi
}

show_usage() {
  cat <<'EOF'
ArkKVM Run Script

Usage:
  ./run.sh <action> <target> [env] [value]

Arguments:
  action    dev | build
  target    device | cloud
  env       test | pro (optional, default: test)
  value     device IP when target=device
            cloud API domain when target=cloud (optional)

Examples:
  ./run.sh dev device test <device-ip>
  DEVICE_IP=<device-ip> ./run.sh dev device
  ./run.sh dev cloud test https://api.example.com
  API_DOMAIN=https://api.example.com ./run.sh dev cloud
  ./run.sh build device pro
  ./run.sh build cloud pro

Environment Variables:
  API_DOMAIN                  Cloud API domain override
  APP_DOMAIN                  Cloud app domain override
  DEVICE_IP                   Device IP used when target=device and value is omitted
  RSB_API_BASE_URL_CLOUD      Cloud API fallback
  API_DOMAIN_CN               China cloud API domain override
  APP_DOMAIN_CN               China cloud app domain override
  CLOUD_BUILD_MODE            Cloud build output mode: versioned | flat
  DEBUG_RUN=1                 Print resolved environment details
  DEBUG_BUILD=1               Print selected Rsbuild resolved values
  ARKKVM_CLOUD_RUNTIME_ONLY=1 Clear injected API/App addresses for cloud builds

Release builds:
  The build action uses the existing version; it does not generate a new
  version, write dist version files, or create/update ZIP archives.
  Use ./build.sh for runtime Cloud + Device, or ./build.sh --version VERSION
  for a versioned Cloud release with ZIP and version files.
EOF
}

read_env_value() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    return 0
  fi

  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
    }
    END {
      if (value != "") {
        print value
      }
    }
  ' "$file"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  show_usage
  exit 0
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  log_error "Invalid argument count."
  echo
  show_usage
  exit 1
fi

action="$1"
target="$2"
env="${3:-test}"
value="${4:-}"

case "$action" in
  dev | build) ;;
  *)
    log_error "Invalid action: $action"
    echo
    show_usage
    exit 1
    ;;
esac

case "$target" in
  device | cloud) ;;
  *)
    log_error "Invalid target: $target"
    echo
    show_usage
    exit 1
    ;;
esac

case "$env" in
  test | pro) ;;
  *)
    log_error "Invalid env: $env"
    echo
    show_usage
    exit 1
    ;;
esac

check_node_version

# Use the same official region defaults as the frontend. Explicit overrides below win.
region_defaults="$(node -e '
  const mapping = require("./cloud-regions.json");
  const regions = mapping[process.argv[1] === "test" ? "test" : "production"];
  console.log(regions.global.apiUrl, regions.global.appUrl, regions.china.apiUrl, regions.china.appUrl);
' "$env")"
read -r DEFAULT_CLOUD_API_DOMAIN DEFAULT_CLOUD_APP_DOMAIN DEFAULT_CLOUD_API_DOMAIN_CN DEFAULT_CLOUD_APP_DOMAIN_CN <<< "$region_defaults"

runtime_cloud_build=0
if [ "$action" = build ] && [ "$target" = cloud ] && [ "${ARKKVM_CLOUD_RUNTIME_ONLY:-0}" = 1 ]; then
  runtime_cloud_build=1
fi
env_file=".env.${env}"
if [ "$runtime_cloud_build" -eq 1 ]; then env_file=''; fi
env_app_version="$(read_env_value "$env_file" "RSB_APP_VERSION")"
env_cloud_api_domain="$(read_env_value "$env_file" "RSB_API_BASE_URL_CLOUD")"
env_cloud_app_domain="$(read_env_value "$env_file" "RSB_APP_BASE_URL_CLOUD")"
env_cloud_api_domain_cn="$(read_env_value "$env_file" "RSB_API_BASE_URL_CLOUD_CN")"
env_cloud_app_domain_cn="$(read_env_value "$env_file" "RSB_APP_BASE_URL_CLOUD_CN")"

if [ -n "${ARKKVM_BUILD_VERSION:-}" ]; then
  export RSB_APP_VERSION="$ARKKVM_BUILD_VERSION"
elif [ -n "$env_app_version" ]; then
  export RSB_APP_VERSION="$env_app_version"
fi

if [ "$target" = "device" ]; then
  device_ip="${value:-${DEVICE_IP:-}}"
  api_domain="${API_DOMAIN:-${RSB_API_BASE_URL_CLOUD:-${env_cloud_api_domain:-$DEFAULT_CLOUD_API_DOMAIN}}}"
else
  device_ip=""
  api_domain="${value:-${API_DOMAIN:-${RSB_API_BASE_URL_CLOUD:-${env_cloud_api_domain:-$DEFAULT_CLOUD_API_DOMAIN}}}}"
fi

app_domain="${APP_DOMAIN:-${env_cloud_app_domain:-$DEFAULT_CLOUD_APP_DOMAIN}}"
if [ "$runtime_cloud_build" -eq 1 ]; then
  api_domain=''
  app_domain=''
fi

if [ "$action" = "dev" ] && [ "$target" = "device" ] && [ -z "$device_ip" ]; then
  log_error "Device IP is required for device dev mode."
  echo
  echo "Examples:"
  echo "  ./run.sh dev device test <device-ip>"
  echo "  DEVICE_IP=<device-ip> ./run.sh dev device"
  exit 1
fi

export RSB_IP_ADDRESS="$device_ip"
export RSB_API_DOMAIN="$api_domain"
export BUILD_TARGET="$target"
export RSB_BUILD_TARGET="$target"
export RSB_TARGET_MODE="$env"
export RSB_API_BASE_URL_CLOUD="$api_domain"
export RSB_APP_BASE_URL_CLOUD="$app_domain"
export RSB_API_BASE_URL_CLOUD_CN="${API_DOMAIN_CN:-${env_cloud_api_domain_cn:-$DEFAULT_CLOUD_API_DOMAIN_CN}}"
export RSB_APP_BASE_URL_CLOUD_CN="${APP_DOMAIN_CN:-${env_cloud_app_domain_cn:-$DEFAULT_CLOUD_APP_DOMAIN_CN}}"
if [ "$runtime_cloud_build" -eq 1 ]; then
  export RSB_API_BASE_URL_CLOUD_CN=''
  export RSB_APP_BASE_URL_CLOUD_CN=''
  export RSB_TARGET_MODE=production
fi

if [ "$target" = "cloud" ]; then
  export RSB_API_BASE_URL="$api_domain"
elif [ "$action" = "dev" ]; then
  export RSB_API_BASE_URL="$device_ip/"
else
  export RSB_API_BASE_URL=""
fi

if [ "$runtime_cloud_build" -eq 1 ]; then
  log_info "action=$action target=cloud config=runtime"
else
  log_info "action=$action target=$target env=$env"
fi
if [ "$target" = "device" ]; then
  log_info "device IP: $device_ip"
else
  if [ "$runtime_cloud_build" -eq 1 ]; then
    log_info 'cloud API: runtime JSON or official hostname'
  else
    log_info "cloud API: $api_domain"
  fi
fi

if [ "${DEBUG_RUN:-0}" = "1" ]; then
  log_info "DEBUG_RUN=1"
  log_info "env file: $env_file"
  log_info "BUILD_TARGET=$BUILD_TARGET"
  log_info "RSB_BUILD_TARGET=$RSB_BUILD_TARGET"
  log_info "RSB_TARGET_MODE=$RSB_TARGET_MODE"
  log_info "RSB_API_BASE_URL=$RSB_API_BASE_URL"
  log_info "RSB_API_BASE_URL_CLOUD=$RSB_API_BASE_URL_CLOUD"
  log_info "RSB_APP_BASE_URL_CLOUD=$RSB_APP_BASE_URL_CLOUD"
  log_info "RSB_API_BASE_URL_CLOUD_CN=$RSB_API_BASE_URL_CLOUD_CN"
  log_info "RSB_APP_BASE_URL_CLOUD_CN=$RSB_APP_BASE_URL_CLOUD_CN"
  log_info "RSB_APP_VERSION=${RSB_APP_VERSION:-<unset>}"
fi

if [ "$action" = "dev" ]; then
  if [ "$target" = "cloud" ]; then
    port="80"
  else
    port="9000"
  fi

  log_info "starting dev server on port $port"
  run_pnpm rsbuild dev --open --port "$port"
else
  log_info "starting production build"
  run_pnpm rsbuild build --mode production
fi
