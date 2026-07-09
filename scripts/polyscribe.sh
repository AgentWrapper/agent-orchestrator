#!/usr/bin/env bash
#
# build-agent-instructions.sh
#
# @sx-managed: polyscribe (vault) — do not edit; managed by the agent-vault hook
#
# Assemble modular markdown PRIMITIVES into the per-agent instruction files the
# coding tools read, at TWO scopes:
#
#   REPO scope (committed to repo root):
#     AGENTS.md  (Codex)  = banner + source/*.md + agent-overrides/codex.md  ← full inline
#     CLAUDE.md  (Claude) = banner + source/*.md + agent-overrides/claude.md ← full inline
#     GEMINI.md  (agy)    = banner + source/*.md + agent-overrides/agy.md     ← full inline
#     AGENTS.shared.md    = banner + source/*.md (no identity)               ← reference artifact
#
#   SYSTEM scope (written into $HOME, applies in EVERY repo) — universal rules:
#     ~/.codex/AGENTS.md  ~/.claude/CLAUDE.md  ~/.gemini/GEMINI.md = banner + system/*.md (full)
#
# Each tool natively reads its global file AND the repo file and merges them, so
# universal rules reach every repo with no repo-side wiring. Every client file is a
# full inline file (no @import) so the shared rule/workflow body is loaded at full
# prominence for every agent — an @import wrapper demotes that body behind an
# import for the importing client, so each client carries the body inline instead.
#
# A primitive named "<name>.ref.md" instead of "<name>.md" is INLINED as usual,
# but flagged REF in the length report — the convention for "this is a short
# pointer that tells the agent to read a bigger file on demand" (context-budget
# escape hatch). The build reports lengths so you can manage what to inline vs ref.
#
# HTML comments are AUTHORING-ONLY. Any <!-- ... --> block in a source primitive
# or override (multi-line included) is stripped during assembly and never reaches
# the generated CLAUDE.md/AGENTS.md/GEMINI.md. Use them for provenance, refresh
# markers (e.g. "@sx-managed: <module>", which only nickify reads off the SOURCE
# file), and notes to whoever edits the fragment — none of that authoring metadata
# is agent-facing, and inlining it verbatim is worse than useless to a reading LLM.
# The one HTML comment that DOES survive is the generated banner below, because it
# is printed directly, not read from a source file.
#
# Edit agent-instructions/source|agent-overrides|system, never the generated files.
#
# Usage (toolchain-free — no npm required):
#   bash scripts/polyscribe.sh            # build + write the REPO files, print length report
#   bash scripts/polyscribe.sh --check    # build REPO files to temp, diff, exit 1 on drift (CI)
#   bash scripts/polyscribe.sh --system   # build + write the SYSTEM (global $HOME) files
#                                          #   honors AGENTS_SYSTEM_HOME to retarget for testing
#   (Node repos MAY alias these as `npm run agents[:check|:system]` — optional convenience,
#    added by nickify only when a package.json already exists. Not required.)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

AI_DIR="${REPO_ROOT}/agent-instructions"
SRC_DIR="${AI_DIR}/source"
OVR_DIR="${AI_DIR}/agent-overrides"
SYS_DIR="${AI_DIR}/system"

BANNER='<!-- GENERATED — DO NOT EDIT. Edit agent-instructions/{source,agent-overrides,system}/, then rebuild: bash scripts/polyscribe.sh (system scope adds --system) -->'
CEILING=200

# --- REPO scope (NEVER glob — order is explicit) -----------------------------
# Every client file (AGENTS.md, CLAUDE.md, GEMINI.md) is a FULL inline file:
# banner + the shared source/*.md body + that client's identity. None use @import.
# An @import wrapper demotes the shared rule/workflow body behind an import and
# agents under-weight it; every client is inlined instead (each carries ONLY its
# own identity, so the Codex identity never bleeds into CLAUDE.md/GEMINI.md).
# AGENTS.shared.md remains as an identity-free shared-body reference artifact
# (no longer a load path).
# Module discovery (v5): if the repo carries ordered numbered fragments
# (NN-*.md / NN-*.ref.md) under agent-instructions/source/, assemble those in
# sorted order. Otherwise fall back to the legacy fixed module list, so
# existing consumers keep building unchanged.
SOURCE_MODULES=(core coding safety project-context repo-style)   # legacy fallback
discover_numbered_modules() {
  # Echoes sorted module basenames (without .md/.ref.md) for NN-*.{md,ref.md}.
  local d="$1" f base
  ls "$d"/[0-9][0-9]-*.md 2>/dev/null | LC_ALL=C sort | while read -r f; do
    base="$(basename "$f")"
    base="${base%.ref.md}"; base="${base%.md}"
    printf '%s\n' "$base"
  done | awk '!seen[$0]++'
}
# Prefer numbered fragments when present (SRC_DIR is defined above).
if _numbered="$(discover_numbered_modules "$SRC_DIR")" && [[ -n "$_numbered" ]]; then
  mapfile -t SOURCE_MODULES <<<"$_numbered"
fi
unset _numbered
REPO_CANONICAL="AGENTS.md"             # full: shared body + Codex identity (Codex reads it whole)
REPO_CANONICAL_OVERRIDE="codex"
REPO_SHARED="AGENTS.shared.md"         # shared body ONLY (no agent identity) — reference artifact
REPO_CLIENTS=(CLAUDE.md GEMINI.md)     # full inline files: shared body + own identity (no @import)
REPO_CLIENT_OVERRIDES=(claude agy)

# --- SYSTEM scope ------------------------------------------------------------
SYSTEM_MODULES=(response-style)
# Native global path per tool. AGENTS_SYSTEM_HOME overrides $HOME (for testing).
SYS_HOME="${AGENTS_SYSTEM_HOME:-$HOME}"
SYSTEM_OUTPUTS=("${SYS_HOME}/.codex/AGENTS.md" "${SYS_HOME}/.claude/CLAUDE.md" "${SYS_HOME}/.gemini/GEMINI.md")

# --- Helpers -----------------------------------------------------------------
die() { printf 'build-agent-instructions: %s\n' "$*" >&2; exit 1; }

# Resolve a module basename to its file: prefer <name>.md, else <name>.ref.md.
module_file() {
  local dir="$1" mod="$2"
  if [[ -f "${dir}/${mod}.md" ]]; then printf '%s' "${dir}/${mod}.md"
  elif [[ -f "${dir}/${mod}.ref.md" ]]; then printf '%s' "${dir}/${mod}.ref.md"
  else die "missing module: ${dir}/${mod}.md (or ${mod}.ref.md)"; fi
}

# Strip HTML comments (<!-- ... -->), including multi-line spans and multiple
# comments per line. Authoring-only metadata (provenance, @sx-managed refresh
# markers, notes to the fragment editor) lives in these comments and must NOT
# reach the agent-facing generated file. Takes a file arg, writes stripped stdout.
# Fails LOUDLY (exit 3) if the file ends while still inside a comment: an
# unterminated "<!--" would otherwise silently swallow the entire rest of the
# fragment — dropping real instructions with no signal. Abort the build instead,
# so the existing generated files are left untouched and the mistake is visible.
strip_html_comments() {
  local f="$1"
  awk '
    BEGIN { incomment = 0 }
    {
      line = $0; out = ""
      while (1) {
        if (incomment) {
          p = index(line, "-->")
          if (p == 0) { line = ""; break }   # comment continues past end of line
          line = substr(line, p + 3); incomment = 0
        }
        s = index(line, "<!--")
        if (s == 0) { out = out line; break }
        out = out substr(line, 1, s - 1)      # keep text before the comment
        line = substr(line, s + 4); incomment = 1
      }
      print out
    }
    END { if (incomment) exit 3 }            # unterminated comment → hard failure
  ' "$f"
}

# Emit a file with HTML comments stripped, then leading/trailing/interior-run
# blank lines trimmed (so a stripped leading comment block leaves no gap).
emit_trimmed() {
  local f="$1"
  [[ -f "$f" ]] || die "missing module: $f"
  # Capture on its own line so the assignment carries strip_html_comments' exit
  # status (a combined `local x=$(...)` would mask it behind local's status).
  local stripped
  stripped="$(strip_html_comments "$f")" \
    || die "unterminated HTML comment (<!-- with no matching -->) in $f"
  printf '%s\n' "$stripped" | awk '
    BEGIN { started = 0; pending = 0 }
    {
      if ($0 ~ /^[[:space:]]*$/) { if (started) pending++; next }
      if (started) { for (i = 0; i < pending; i++) print "" }
      pending = 0; print; started = 1
    }
  '
}

# Emit one module. A normal <name>.md is inlined; a <name>.ref.md is the
# by-reference escape hatch — its body is NOT inlined, only a one-line pointer
# telling the agent to read the file on demand (keeps the assembled file small).
emit_module() {
  local dir="$1" mod="$2" f
  f="$(module_file "$dir" "$mod")"
  if [[ "$f" == *.ref.md ]]; then
    printf 'For **%s**, read `%s` when relevant (referenced on demand, not inlined here).\n' \
      "$mod" "${f#"$REPO_ROOT"/}"
  else
    emit_trimmed "$f"
  fi
}

# banner + each module (resolved .md/.ref.md), one blank line between, then an
# optional trailing override module with no separator after it.
emit_assembled() {
  local dir="$1"; shift
  local override_file="$1"; shift # may be empty
  local mod first=1
  printf '%s\n\n' "$BANNER"
  # Separator goes BEFORE each module (except the first) and before the override,
  # so an empty-override output (AGENTS.shared.md, system files) has no trailing blank.
  for mod in "$@"; do
    [[ $first -eq 1 ]] || printf '\n'
    emit_module "$dir" "$mod"
    first=0
  done
  if [[ -n "$override_file" ]]; then
    printf '\n'
    emit_trimmed "$override_file"
  fi
}

# --- Length report -----------------------------------------------------------
report_modules() {
  local dir="$1"; shift
  local mod f n tag
  for mod in "$@"; do
    f="$(module_file "$dir" "$mod")"
    n="$(wc -l <"$f" | tr -d ' ')"
    if [[ "$f" == *.ref.md ]]; then
      # by-reference: emits a single pointer line regardless of on-disk size.
      printf '    %-22s %4s   REF (→1 line; %s on disk)\n' "$mod" "1" "$n"
    else
      tag=""; [[ "$n" -gt "$CEILING" ]] && tag="  ⚠ OVER"
      printf '    %-22s %4s%s\n' "$mod" "$n" "$tag"
    fi
  done
}
report_output() {
  local label="$1" path="$2" n tag
  [[ -f "$path" ]] || { printf '    %-22s   (not built)\n' "$label"; return; }
  n="$(wc -l <"$path" | tr -d ' ')"
  tag=""; [[ "$n" -gt "$CEILING" ]] && tag="  ⚠ OVER"
  printf '    %-22s %4s%s\n' "$label" "$n" "$tag"
}

# --- Preflight ---------------------------------------------------------------
preflight_repo() {
  [[ -d "$SRC_DIR" ]] || die "missing $SRC_DIR"
  [[ -d "$OVR_DIR" ]] || die "missing $OVR_DIR"
  local m i
  for m in "${SOURCE_MODULES[@]}"; do module_file "$SRC_DIR" "$m" >/dev/null; done
  [[ -f "${OVR_DIR}/${REPO_CANONICAL_OVERRIDE}.md" ]] || die "missing ${OVR_DIR}/${REPO_CANONICAL_OVERRIDE}.md"
  for i in "${!REPO_CLIENT_OVERRIDES[@]}"; do
    [[ -f "${OVR_DIR}/${REPO_CLIENT_OVERRIDES[$i]}.md" ]] || die "missing ${OVR_DIR}/${REPO_CLIENT_OVERRIDES[$i]}.md"
  done
}
preflight_system() {
  [[ -d "$SYS_DIR" ]] || die "missing $SYS_DIR"
  local m
  for m in "${SYSTEM_MODULES[@]}"; do module_file "$SYS_DIR" "$m" >/dev/null; done
}

# Render one REPO output filename to stdout.
render_repo() {
  local out="$1" i
  if [[ "$out" == "$REPO_CANONICAL" ]]; then
    # Canonical: shared body + Codex identity (Codex reads this whole; no import).
    emit_assembled "$SRC_DIR" "${OVR_DIR}/${REPO_CANONICAL_OVERRIDE}.md" "${SOURCE_MODULES[@]}"
    return
  fi
  if [[ "$out" == "$REPO_SHARED" ]]; then
    # Shared body ONLY — no agent identity. Reference artifact (no longer imported).
    emit_assembled "$SRC_DIR" "" "${SOURCE_MODULES[@]}"
    return
  fi
  for i in "${!REPO_CLIENTS[@]}"; do
    if [[ "${REPO_CLIENTS[$i]}" == "$out" ]]; then
      # Full inline file: shared body + this client's OWN identity (no @import, no
      # Codex-identity bleed).
      emit_assembled "$SRC_DIR" "${OVR_DIR}/${REPO_CLIENT_OVERRIDES[$i]}.md" "${SOURCE_MODULES[@]}"; return
    fi
  done
  die "no builder for repo output: $out"
}

REPO_ALL=("$REPO_CANONICAL" "$REPO_SHARED" "${REPO_CLIENTS[@]}")

# --- Modes -------------------------------------------------------------------
MODE="build"
case "${1:-}" in
  --check) MODE="check" ;;
  --system) MODE="system" ;;
  '') : ;;
  *) die "unknown argument: $1 (use --check, --system, or no args)" ;;
esac

if [[ "$MODE" == "check" ]]; then
  preflight_repo
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  drift=0
  for out in "${REPO_ALL[@]}"; do
    render_repo "$out" >"${tmp}/${out}"
    diff -u "${REPO_ROOT}/${out}" "${tmp}/${out}" --label "committed/${out}" --label "freshly-built/${out}" || drift=1
  done
  [[ $drift -ne 0 ]] && die "repo agent instruction files are stale. Run: bash scripts/polyscribe.sh"
  printf 'build-agent-instructions: repo files (AGENTS.md + CLAUDE.md/GEMINI.md inline + AGENTS.shared.md) up to date.\n'
  exit 0
fi

if [[ "$MODE" == "system" ]]; then
  preflight_system
  # Two-phase for atomicity (same rationale as the repo build below): render all
  # system outputs to temps, then move them into place only if all succeed.
  sys_tmps=(); sys_dsts=()
  cleanup_sys_tmps() { local t; for t in "${sys_tmps[@]:-}"; do [[ -n "$t" ]] && rm -f "$t"; done; }
  trap cleanup_sys_tmps EXIT
  for path in "${SYSTEM_OUTPUTS[@]}"; do
    mkdir -p "$(dirname "$path")"
    tmpf="$(mktemp "${path}.XXXXXX")"
    sys_tmps+=("$tmpf"); sys_dsts+=("$path")
    emit_assembled "$SYS_DIR" "" "${SYSTEM_MODULES[@]}" >"$tmpf"   # dies here on a malformed fragment; nothing moved yet
  done
  for i in "${!sys_tmps[@]}"; do
    mv -f "${sys_tmps[$i]}" "${sys_dsts[$i]}"
    printf 'wrote %s\n' "${sys_dsts[$i]}"
  done
  sys_tmps=(); trap - EXIT
  printf '\nagent-instructions: SYSTEM length report (ceiling %s, home=%s)\n' "$CEILING" "$SYS_HOME"
  printf '  primitives (system/):\n'; report_modules "$SYS_DIR" "${SYSTEM_MODULES[@]}"
  printf '  outputs:\n'
  for path in "${SYSTEM_OUTPUTS[@]}"; do report_output "$path" "$path"; done
  exit 0
fi

# --- build (repo) ------------------------------------------------------------
# Two-phase for atomicity: render EVERY output to a temp first, and only move
# them into place once all have rendered cleanly. If a render dies partway
# (e.g. an unterminated comment in a late-rendered override), the EXIT trap
# removes the temps and the committed files are left untouched — never a
# half-updated set split across source versions.
preflight_repo
build_tmps=(); build_dsts=()
cleanup_build_tmps() { local t; for t in "${build_tmps[@]:-}"; do [[ -n "$t" ]] && rm -f "$t"; done; }
trap cleanup_build_tmps EXIT
for out in "${REPO_ALL[@]}"; do
  tmpf="$(mktemp "${REPO_ROOT}/.${out}.XXXXXX")"
  build_tmps+=("$tmpf"); build_dsts+=("${REPO_ROOT}/${out}")
  render_repo "$out" >"$tmpf"        # dies here on a malformed fragment; nothing moved yet
done
for i in "${!build_tmps[@]}"; do
  mv -f "${build_tmps[$i]}" "${build_dsts[$i]}"
  printf 'wrote %s\n' "${build_dsts[$i]}"
done
build_tmps=()   # all moved; nothing left for the trap to clean
trap - EXIT
printf '\nagent-instructions: REPO length report (ceiling %s)\n' "$CEILING"
printf '  primitives (source/):\n'; report_modules "$SRC_DIR" "${SOURCE_MODULES[@]}"
printf '  overrides:\n'; report_modules "$OVR_DIR" "$REPO_CANONICAL_OVERRIDE" "${REPO_CLIENT_OVERRIDES[@]}"
printf '  outputs:\n'
report_output "AGENTS.md (canonical)" "${REPO_ROOT}/AGENTS.md"
report_output "AGENTS.shared.md (body)" "${REPO_ROOT}/AGENTS.shared.md"
report_output "CLAUDE.md (inline)" "${REPO_ROOT}/CLAUDE.md"
report_output "GEMINI.md (inline)" "${REPO_ROOT}/GEMINI.md"
