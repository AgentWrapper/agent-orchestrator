#!/usr/bin/env bash
# One-shot, idempotent setup of the local AO dev services on a macOS machine.
# Makes a fresh machine reproducible from this repo alone:
#   clone → scripts/dev-setup.sh → daemon + LAN web UI running under launchd.
#
# Installs/refreshes:
#   - ao binary        (daemon-build.sh → PATH install + ~/.ao/bin/ao copy)
#   - service scripts  (ao-daemon.sh, lan-web-server.sh, ao-svc → ~/.ao/)
#   - launchd plists   (generated → ~/Library/LaunchAgents/)
#   - ~/dev/ag-orc     (symlink to this checkout; lan-web serves from it)
#
# Safe to re-run: already-loaded jobs are left running (prints the kickstart
# command instead — a daemon restart re-parks live sessions at claude --resume).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
la_dir="${HOME}/Library/LaunchAgents"
dom="gui/$(id -u)"

# 1. daemon binary: build + PATH install, then the copy launchd actually runs
"${script_dir}/daemon-build.sh"
mkdir -p "${HOME}/.ao/bin"
cp -f "${XDG_CACHE_HOME:-${HOME}/.cache}/aoagents/agent-orchestrator/bin/ao" "${HOME}/.ao/bin/ao"
echo "Installed ~/.ao/bin/ao"

# 2. service scripts (deploy-by-copy; launchd runs the ~/.ao copies)
cp -f "${script_dir}/ao-daemon.sh" "${script_dir}/lan-web-server.sh" "${script_dir}/ao-svc" "${HOME}/.ao/"
echo "Installed ~/.ao/{ao-daemon.sh,lan-web-server.sh,ao-svc}"

# 3. ~/dev/ag-orc → this checkout (lan-web-server.sh serves its frontend/)
if [[ -e "${HOME}/dev/ag-orc" && ! -L "${HOME}/dev/ag-orc" ]]; then
  echo "⚠ ~/dev/ag-orc exists and is not a symlink — leaving it alone" >&2
else
  mkdir -p "${HOME}/dev"
  ln -sfn "${repo_root}" "${HOME}/dev/ag-orc"
  echo "Linked ~/dev/ag-orc → ${repo_root}"
fi

# 4. launchd plists (generated here so the repo is the source of truth)
mkdir -p "${la_dir}"
cat > "${la_dir}/dev.agent-orchestrator.daemon.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.agent-orchestrator.daemon</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/zsh</string>
		<string>-lc</string>
		<string>exec "\$HOME/.ao/ao-daemon.sh"</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>TERM</key>
		<string>xterm-256color</string>
		<key>LANG</key>
		<string>en_US.UTF-8</string>
	</dict>
	<key>WorkingDirectory</key>
	<string>${HOME}/.ao</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${HOME}/.ao/daemon.out.log</string>
	<key>StandardErrorPath</key>
	<string>${HOME}/.ao/daemon.err.log</string>
</dict>
</plist>
PLIST

cat > "${la_dir}/dev.agent-orchestrator.lan-web.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>dev.agent-orchestrator.lan-web</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/zsh</string>
		<string>-lc</string>
		<string>exec "\$HOME/.ao/lan-web-server.sh"</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${HOME}/.ao/lan-web.out.log</string>
	<key>StandardErrorPath</key>
	<string>${HOME}/.ao/lan-web.err.log</string>
</dict>
</plist>
PLIST
echo "Wrote launchd plists to ~/Library/LaunchAgents/"

# 5. load jobs — never restart an already-running daemon (live sessions!)
for job in dev.agent-orchestrator.daemon dev.agent-orchestrator.lan-web; do
  if launchctl print "${dom}/${job}" >/dev/null 2>&1; then
    echo "loaded: ${job} (already running — to apply changes:"
    echo "         launchctl kickstart -k \"${dom}/${job}\")"
  else
    launchctl bootstrap "${dom}" "${la_dir}/${job}.plist"
    echo "loaded: ${job}"
  fi
done

# 6. non-fatal checks for the bits this script won't do for you
[[ -x "${repo_root}/frontend/node_modules/.bin/vite" ]] \
  || echo "⚠ lan-web needs vite: cd frontend && npm install"
grep -q "ao-svc" "${HOME}/.zshrc" 2>/dev/null \
  || echo "⚠ add to ~/.zshrc:  alias ao-svc=\"\$HOME/.ao/ao-svc\""
for tool in tmux claude; do
  command -v "${tool}" >/dev/null || echo "⚠ ${tool} not on PATH (sessions need it)"
done

echo "Done. Health: ao status && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/"
