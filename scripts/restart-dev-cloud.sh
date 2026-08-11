#!/bin/sh

set -eu

# Default env file: prefer the current `.env.cloud.local` name, but fall back to
# the legacy `.env.public.local` so existing local setups keep working. Both are
# gitignored; the wire value inside is still RELAY_BROKER_AUTH_MODE=public.
if [ "$#" -ge 1 ]; then
  env_file="$1"
elif [ -f ".env.cloud.local" ]; then
  env_file=".env.cloud.local"
else
  env_file=".env.public.local"
fi

pkill -f "node scripts/dev-full.mjs" >/dev/null 2>&1 || true
pkill -f "vite --host --port 5173 --strictPort" >/dev/null 2>&1 || true
pkill -f "vite --host" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-server" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-server" >/dev/null 2>&1 || true
pkill -f "cargo run -p relay-broker" >/dev/null 2>&1 || true
pkill -f "target/debug/relay-broker" >/dev/null 2>&1 || true

if [ -f "$env_file" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
else
  echo "restart-dev-cloud: missing env file: $env_file" >&2
  exit 1
fi

npm run build

echo "restart-dev-cloud: starting relay-server at http://${BIND_HOST:-127.0.0.1}:${PORT:-8787}"
# The control URL is optional: the two-variable quickstart env sets only
# RELAY_BROKER_URL and the relay derives the control URL from it. Guard the
# expansion so `set -u` does not abort before the relay even starts.
echo "restart-dev-cloud: using broker ${RELAY_BROKER_CONTROL_URL:-${RELAY_BROKER_URL:-<derived by relay-server>}}"

# Build with the orchestration engines when this checkout has them, and say which
# of the two it got. A cloud relay is where long task lists actually get started,
# so starting one that answers every request with "not available in this build" is
# the worst place to discover the feature was compiled out — see PRIVATE_ENGINES.md.
if [ -d "$(dirname "$0")/../crates/relay-orchestrators/src/team" ]; then
  echo "restart-dev-cloud: orchestration engines present — building with them"
  exec cargo run -p relay-server --features orchestrators
fi
echo "restart-dev-cloud: stub orchestration engine — task list and task team are off"
exec cargo run -p relay-server
