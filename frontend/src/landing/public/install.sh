#!/bin/sh
set -eu

REPO="${AO_INSTALL_REPO:-AgentWrapper/agent-orchestrator}"
BASE_URL="${AO_INSTALL_BASE_URL:-https://github.com/$REPO/releases/latest/download}"

say() {
	printf '%s\n' "$*"
}

fail() {
	printf 'ao install: %s\n' "$*" >&2
	exit 1
}

has() {
	command -v "$1" >/dev/null 2>&1
}

download() {
	url="$1"
	dest="$2"

	if has curl; then
		curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"
		return
	fi

	if has wget; then
		wget -qO "$dest" "$url"
		return
	fi

	fail "curl or wget is required"
}

os="$(uname -s)"
arch="$(uname -m)"

case "$os:$arch" in
	Darwin:arm64 | Darwin:aarch64)
		platform="macos"
		asset="agent-orchestrator-darwin-arm64.zip"
		;;
	Darwin:x86_64 | Darwin:amd64)
		platform="macos"
		asset="agent-orchestrator-darwin-x64.zip"
		;;
	Linux:x86_64 | Linux:amd64)
		platform="linux"
		asset="agent-orchestrator-linux-x64.AppImage"
		;;
	MINGW* | MSYS* | CYGWIN*)
		fail "use PowerShell instead: irm https://aoagents.dev/install.ps1 | iex"
		;;
	*)
		fail "unsupported platform: $os $arch"
		;;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/ao-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

url="$BASE_URL/$asset"
say "Downloading Agent Orchestrator from $url"

case "$platform" in
	macos)
		has unzip || fail "unzip is required"
		archive="$tmp/$asset"
		unpack_dir="$tmp/unpack"
		mkdir -p "$unpack_dir"
		download "$url" "$archive"
		unzip -q "$archive" -d "$unpack_dir"

		app_path="$(find "$unpack_dir" -maxdepth 3 -type d -name '*.app' | head -n 1)"
		[ -n "$app_path" ] || fail "download did not contain a .app bundle"

		app_name="$(basename "$app_path")"
		if [ -n "${AO_INSTALL_DIR:-}" ]; then
			install_dir="$AO_INSTALL_DIR"
		elif [ -d /Applications ] && [ -w /Applications ]; then
			install_dir="/Applications"
		else
			install_dir="$HOME/Applications"
		fi

		mkdir -p "$install_dir"
		rm -rf "$install_dir/$app_name"
		cp -R "$app_path" "$install_dir/"
		say "Installed $app_name to $install_dir"
		say "Open it with: open '$install_dir/$app_name'"
		;;
	linux)
		install_dir="${AO_INSTALL_DIR:-$HOME/.local/bin}"
		dest="$install_dir/agent-orchestrator"
		mkdir -p "$install_dir"
		download "$url" "$dest"
		chmod +x "$dest"
		say "Installed Agent Orchestrator AppImage to $dest"
		case ":$PATH:" in
			*":$install_dir:"*) ;;
			*) say "Add $install_dir to PATH or run it directly: $dest" ;;
		esac
		;;
esac

say "Next: open Agent Orchestrator and add your repository."
