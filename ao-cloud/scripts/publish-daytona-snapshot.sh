#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${AO_CLOUD_HOSTED_ENV_FILE:-$root/ao-cloud/.env.hosted}"
provided_api_key="${AO_DAYTONA_API_KEY:-}"
provided_snapshot="${AO_DAYTONA_WORKER_SNAPSHOT:-}"
provided_version="${AO_WORKER_VERSION:-}"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

if [[ -n "$provided_api_key" ]]; then AO_DAYTONA_API_KEY="$provided_api_key"; fi
if [[ -n "$provided_snapshot" ]]; then AO_DAYTONA_WORKER_SNAPSHOT="$provided_snapshot"; fi
if [[ -n "$provided_version" ]]; then AO_WORKER_VERSION="$provided_version"; fi

: "${AO_DAYTONA_API_KEY:?set AO_DAYTONA_API_KEY in .env.hosted}"
: "${AO_DAYTONA_WORKER_SNAPSHOT:?set AO_DAYTONA_WORKER_SNAPSHOT in .env.hosted}"
: "${AO_WORKER_VERSION:?set AO_WORKER_VERSION to the current Git commit}"

if ! command -v daytona >/dev/null 2>&1; then
  echo "daytona CLI is required; install it before publishing a worker snapshot." >&2
  exit 1
fi

expected_version="$(git -C "$root" rev-parse HEAD)"
if [[ "$AO_WORKER_VERSION" != "$expected_version" ]]; then
  echo "AO_WORKER_VERSION must equal the current Git commit ($expected_version)." >&2
  exit 1
fi

daytona login --api-key "$AO_DAYTONA_API_KEY"
daytona snapshot create "$AO_DAYTONA_WORKER_SNAPSHOT" \
  --dockerfile "$root/ao-cloud/docker/worker.Dockerfile" \
  --context "$root"

echo "Published Daytona worker snapshot: $AO_DAYTONA_WORKER_SNAPSHOT"
