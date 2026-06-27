#!/bin/zsh
# launchd-run wrapper for the AO daemon.
# Pins AO_ALLOWED_ORIGINS to the CURRENT LAN IP so the UI's terminal-attach
# WebSocket (GET /mux from http://<lan-ip>:3000) isn't rejected with 403 after a
# DHCP lease change. lan-web-server.sh derives the same IP for the UI, so the two
# always agree. See ~/.ao/FEREADME.md for the full gotcha.
#
# NOTE: a launchd-spawned daemon can't read the ~/Desktop project repos (macOS
# TCC). For sessions that need those, stop this job and start from a terminal:
#   launchctl bootout gui/$(id -u)/dev.agent-orchestrator.daemon
#   AO_ALLOWED_ORIGINS=http://<lan-ip>:3000 ao start
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"

IP=$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null)

exec env AO_ALLOWED_ORIGINS="http://${IP}:3000" "$HOME/.ao/bin/ao" daemon
