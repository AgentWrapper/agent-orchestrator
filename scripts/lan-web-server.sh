#!/bin/zsh
# Durable LAN web UI for Agent Orchestrator.
# Ensures the daemon is up with the LAN CORS origin allowlisted, then runs the
# Vite renderer dev server bound to the LAN on :3000. launchd supervises this
# (KeepAlive), so it survives shell death, crashes, and reboots.
#
# Operational runbook (daemon restart, the AO_ALLOWED_ORIGINS / 403 mux gotcha,
# session resume behavior, file map): see ~/.ao/FEREADME.md
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# node lives under nvm, which is initialized in ~/.zshrc (interactive only, not
# sourced by a `zsh -lc` login shell). Resolve it explicitly: source nvm, and
# fall back to the newest installed nvm node bin on PATH.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
_latest_node_bin=$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "$_latest_node_bin" ] && export PATH="$_latest_node_bin:$PATH"

# Current LAN IP, derived at start. DHCP drifts, and a hardcoded IP here (was
# .250) is exactly what broke the UI when the lease moved to .227. The manually
# started daemon must use this same value for AO_ALLOWED_ORIGINS, so the API
# base the browser uses and the daemon's allowed origin always agree.
IP=$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null)

# NOTE: this LaunchAgent intentionally does NOT start the daemon. The skyvern /
# skyvern-cloud project repos live under ~/Desktop, which macOS TCC blocks for
# launchd-spawned processes — a daemon started here couldn't access them. Start
# the daemon from a terminal (which has Desktop access) instead:
#   AO_ALLOWED_ORIGINS=http://$IP:3000 ao start

cd "$HOME/dev/ag-orc/frontend" || exit 1
exec env VITE_NO_ELECTRON=1 VITE_AO_API_BASE_URL="http://${IP}:3000" \
  ./node_modules/.bin/vite --config vite.renderer.config.ts --host 0.0.0.0 --port 3000 --strictPort
