#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
data_dir="${AO_DATA_DIR:-$HOME/.ao}/cloud-local"
log_dir="$data_dir/logs"
pid_dir="$data_dir/pids"
env_file="$root/.env.cloud.local"

mkdir -p "$log_dir" "$pid_dir"

usage() {
  cat <<'EOF'
Usage: npm run cloud:local [start|stop|clear-db|reset-db]

start (default) installs dependencies, prepares local configuration, builds the
worker and control-plane images, starts the Compose stack, then starts the web
app.
It remains attached and streams logs until Ctrl-C, which stops the stack while
preserving PostgreSQL data.
stop gracefully stops local worker sandboxes, the control plane, web app, and
local PostgreSQL container while preserving volumes.
clear-db stops the stack and permanently deletes local PostgreSQL data without
starting anything afterward. reset-db is a backwards-compatible alias.
EOF
}

ensure_env() {
  if [[ ! -f "$env_file" ]]; then
    cp "$root/ao-cloud/.env.example" "$env_file"
    echo "Created $env_file"
  fi
  if ! grep -q '^AO_ENCRYPTION_KEY=.\+' "$env_file"; then
    printf '\nAO_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >>"$env_file"
  fi
  if ! grep -q '^AO_WORKER_SIGNING_KEY=.\+' "$env_file"; then
    printf 'AO_WORKER_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)" >>"$env_file"
  fi
}

ensure_web_env() {
  local web_env="$root/frontend/src/landing/.env.local"
  if [[ ! -f "$web_env" ]]; then
    printf 'NEXT_PUBLIC_API_URL=http://127.0.0.1:3010\nNEXT_PUBLIC_AO_AUTH_MODE=local\n' >"$web_env"
    echo "Created $web_env"
  fi
}

load_local_env() {
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
}

configure_local_github() {
  if ! command -v gh >/dev/null 2>&1; then
    unset AO_GITHUB_AUTH_MODE
    unset AO_LOCAL_GITHUB_TOKEN
    echo "GitHub repository access is disabled: install and authenticate the gh CLI."
    return
  fi

  local token
  if ! token="$(gh auth token 2>/dev/null)" || [[ -z "$token" ]]; then
    unset AO_GITHUB_AUTH_MODE
    unset AO_LOCAL_GITHUB_TOKEN
    echo "GitHub repository access is disabled: run 'gh auth login'."
    return
  fi
  AO_LOCAL_GITHUB_TOKEN="$token"
  AO_GITHUB_AUTH_MODE="local-gh"
  export AO_LOCAL_GITHUB_TOKEN
  export AO_GITHUB_AUTH_MODE
  echo "Using the host gh authentication token for local GitHub access."
}

running_pid() {
  local name="$1"
  local pid_file="$pid_dir/$name.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start_process() {
  local name="$1"
  local command="$2"
  local log_file="$log_dir/$name.log"
  if running_pid "$name"; then
    echo "$name is already running (pid $(cat "$pid_dir/$name.pid"))."
    return
  fi
  rm -f "$pid_dir/$name.pid"
  (
    cd "$root"
    exec bash -lc "$command"
  ) >>"$log_file" 2>&1 &
  echo $! >"$pid_dir/$name.pid"
  echo "Started $name (log: $log_file)."
}

stop_process() {
  local name="$1"
  local pid_file="$pid_dir/$name.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      local child
      for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill "$child" 2>/dev/null || true
      done
      kill "$pid"
      echo "Stopped $name."
    fi
    rm -f "$pid_file"
  fi
}

stop_local_sandboxes() {
  local ids
  ids="$(docker ps --quiet --filter label=ao.managed=true)"
  if [[ -z "$ids" ]]; then
    return
  fi
  docker stop --time 15 $ids || true
  echo "Stopped local AO worker sandboxes."
}

stop_stack() {
  # Stop sandboxes first so their worker processes can handle SIGTERM while the
  # control plane is still available for their final lifecycle events.
  stop_local_sandboxes
  stop_process sandbox-events
  stop_process web
  stop_process control-plane
  (
    cd "$root"
    docker compose --env-file "$env_file" -f ao-cloud/docker-compose.local.yml stop
  )
}

clear_database() {
  stop_stack
  cd "$root"
  docker compose --env-file "$env_file" -f ao-cloud/docker-compose.local.yml down --volumes
  echo "Deleted local AO Cloud PostgreSQL data."
}

stream_logs() {
  touch "$log_dir/control-plane.log" "$log_dir/web.log" "$log_dir/sandbox-events.log"
  echo
  echo "Streaming local Cloud logs. Press Ctrl-C to stop the local stack."
  local stream_pids=()
  stream_file() {
    local label="$1"
    local file="$2"
    tail -n 0 -F "$file" 2>/dev/null | awk -v label="$label" '
      /ObjectMultiplex - orphaned/ { next }
      /Next.js inferred your workspace root/ { next }
      /Detected additional lockfiles/ { next }
      /^   \* .*package-lock\.json/ { next }
      /"method":"OPTIONS"/ { next }
      /"method":"GET".*"status":200/ &&
        /\/api\/cloud\/v1\/(me|projects|sessions|provider-connections|repositories)/ { next }
      { print "[" label "] " $0; fflush() }
    ' &
    stream_pids+=("$!")
  }
  stream_file CP "$log_dir/control-plane.log"
  stream_file WEB "$log_dir/web.log"
  stream_file DOCKER "$log_dir/sandbox-events.log"
  trap 'kill "${stream_pids[@]}" 2>/dev/null || true; stop_stack; exit 0' INT TERM
  wait "${stream_pids[@]}"
}

start() {
  ensure_env
  ensure_web_env
  load_local_env
  configure_local_github
  cd "$root"
  npm install
  npm --prefix frontend/src/landing install
  npm run cloud:build-image
  docker compose --env-file "$env_file" -f ao-cloud/docker-compose.local.yml up --build -d
  start_process control-plane "docker compose --env-file '$env_file' -f ao-cloud/docker-compose.local.yml logs --no-log-prefix --follow control-plane"
  for _ in {1..30}; do
    if curl --fail --silent http://127.0.0.1:3010/readyz >/dev/null; then
      break
    fi
    sleep 1
  done
  if ! curl --fail --silent http://127.0.0.1:3010/readyz >/dev/null; then
    echo "Control plane did not become ready. Recent logs:"
    tail -n 100 "$log_dir/control-plane.log"
    exit 1
  fi
  start_process web "set -a; . '$env_file'; set +a; export NEXT_PUBLIC_API_URL=http://127.0.0.1:3010 NEXT_PUBLIC_WEB_URL=http://127.0.0.1:5174 NEXT_PUBLIC_AO_AUTH_MODE=\${AO_CLOUD_AUTH_MODE:-local} NEXT_PUBLIC_WORKOS_REDIRECT_URI=\${NEXT_PUBLIC_WORKOS_REDIRECT_URI:-http://127.0.0.1:5174/callback}; exec npm run cloud:web"
  start_process sandbox-events "exec docker events --filter label=ao.managed=true --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}'"
  for _ in {1..30}; do
    if curl --fail --silent http://127.0.0.1:5174/ >/dev/null; then
      break
    fi
    sleep 1
  done
  if ! curl --fail --silent http://127.0.0.1:5174/ >/dev/null; then
    echo "Web app did not become ready. Recent logs:"
    tail -n 100 "$log_dir/web.log"
    exit 1
  fi
  echo
  echo "✓ AO Cloud is ready."
  echo "→ Visit site: http://127.0.0.1:5174"
  echo "→ Press Ctrl-C to stop the local stack and preserve its database."
  stream_logs
}

case "${1:-start}" in
  start) start ;;
  stop) stop_stack ;;
  clear-db|reset-db) clear_database ;;
  -h|--help|help) usage ;;
  *)
    usage
    exit 2
    ;;
esac
