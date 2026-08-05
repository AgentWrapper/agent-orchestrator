#!/bin/sh
set -eu

real_gh="${AO_GH_REAL_BINARY:-/usr/bin/gh}"

if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  exec "$real_gh" "$@"
fi

if [ "${1:-}" = "pr" ]; then
  if [ -z "${AO_CLOUD_PUBLIC_URL:-}" ] || [ -z "${AO_SESSION_ID:-}" ]; then
    echo "AO GitHub credential broker is unavailable: worker context is incomplete." >&2
    exit 1
  fi

  github_repository="${GH_REPO:-}"
  if [ -z "$github_repository" ]; then
    origin="$(git config --get remote.origin.url 2>/dev/null || true)"
    proxy_path="${origin#*/api/cloud/v1/git/}"
    if [ "$proxy_path" != "$origin" ]; then
      proxy_path="${proxy_path%.git}"
      owner="${proxy_path%%/*}"
      repository="${proxy_path#*/}"
      if [ -n "$owner" ] &&
        [ -n "$repository" ] &&
        [ "$repository" != "$proxy_path" ] &&
        [ "${repository#*/}" = "$repository" ]; then
        github_repository="${owner}/${repository}"
      fi
    fi
  fi
  if [ -z "$github_repository" ]; then
    echo "AO GitHub credential broker is unavailable: canonical repository context is missing." >&2
    exit 1
  fi

  worker_token="${AO_WORKER_TOKEN:-}"
  worker_token_path="${AO_DATA_DIR:-}/worker-token"
  if [ -n "${AO_DATA_DIR:-}" ] && [ -f "$worker_token_path" ] && [ -r "$worker_token_path" ]; then
    worker_token="$(tr -d '\r\n' < "$worker_token_path")"
  fi
  if [ -z "$worker_token" ]; then
    echo "AO GitHub credential broker is unavailable: worker token is missing." >&2
    exit 1
  fi

  if ! response="$(
    curl -fsS \
      -X POST \
      -H "Authorization: Worker ${worker_token}" \
      -H "X-AO-Session-ID: ${AO_SESSION_ID}" \
      "${AO_CLOUD_PUBLIC_URL%/}/api/cloud/v1/worker/github-token"
  )"; then
    echo "AO GitHub credential broker request failed; refusing unauthenticated gh fallback." >&2
    exit 1
  fi
  if ! token="$(printf '%s' "$response" | jq -er '.token | select(type == "string" and length > 0)')"; then
    echo "AO GitHub credential broker returned no usable token; refusing unauthenticated gh fallback." >&2
    exit 1
  fi

  GH_REPO="$github_repository" GH_TOKEN="$token" exec "$real_gh" "$@"
fi

exec "$real_gh" "$@"
