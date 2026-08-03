#!/bin/sh
set -eu

real_gh="/usr/bin/gh"

if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  exec "$real_gh" "$@"
fi

if [ "${1:-}" = "pr" ] && [ -n "${AO_CLOUD_PUBLIC_URL:-}" ] && [ -n "${AO_WORKER_TOKEN:-}" ] && [ -n "${AO_SESSION_ID:-}" ]; then
  token="$(
    curl -fsS \
      -X POST \
      -H "Authorization: Worker ${AO_WORKER_TOKEN}" \
      -H "X-AO-Session-ID: ${AO_SESSION_ID}" \
      "${AO_CLOUD_PUBLIC_URL%/}/api/cloud/v1/worker/github-token" \
      | jq -r '.token // empty'
  )"
  if [ -n "$token" ]; then
    GH_TOKEN="$token" exec "$real_gh" "$@"
  fi
fi

exec "$real_gh" "$@"
