#!/usr/bin/env bash
# Guard against an accidental non-stable GitHub release taking over
# /releases/latest and breaking electron-updater's stable channel.
#
# This repo does NOT carry a stable GitHub release: ao's production target is the
# local self-hosted daemon, deployed from source by ops/deploy.sh, and there is no
# updater feed to poison. The guard used to run `gh release view` unconditionally,
# which exits 1 with "release not found" on a repo with no releases — leaving main
# permanently red and training everyone to ignore a red main (#293/D3, from #297).
#
# So: a repo with no stable latest release SKIPS cleanly (neutral notice, exit 0).
# Every other check still fails hard, so the day a stable release IS cut the guard
# does its original job. A genuine API failure (auth, rate limit, network) also
# still fails — silently skipping on any gh error would turn this into decoration.
set -euo pipefail

repo="${REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "${repo}" ]]; then
  echo "::error::REPO (or GITHUB_REPOSITORY) must be set."
  exit 1
fi

# GitHub's /releases/latest deliberately excludes drafts and prereleases, so a
# 404 here means exactly "this repo has no stable latest release" — the state
# this repo is intentionally in.
err_file="$(mktemp)"
trap 'rm -f "${err_file}"' EXIT

if ! release_json="$(gh api "repos/${repo}/releases/latest" 2>"${err_file}")"; then
  # Key strictly on the 404 STATUS, never on the message text: a 403 body can say
  # "Not Found" too, and masking a rate limit as "no release" would make this
  # guard decorative.
  if grep -qF '(HTTP 404)' "${err_file}"; then
    echo "::notice::${repo} has no stable GitHub release. ao deploys from source via ops/deploy.sh to a local self-hosted daemon and ships no electron-updater feed, so there is no stable channel for this guard to protect. Skipping."
    exit 0
  fi
  cat "${err_file}" >&2
  echo "::error::Could not query the latest release for ${repo} (this is an API failure, not an absent release)."
  exit 1
fi

tag="$(jq -r '.tag_name // ""' <<<"${release_json}")"
prerelease="$(jq -r '.prerelease // false' <<<"${release_json}")"
draft="$(jq -r '.draft // false' <<<"${release_json}")"

echo "Latest release: ${tag}"

if [[ "${draft}" == "true" || "${prerelease}" == "true" ]]; then
  echo "::error::GitHub latest resolved to draft/prerelease '${tag}'; stable latest must be a published non-prerelease."
  exit 1
fi

if [[ ! "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::GitHub latest resolved to '${tag}'; expected a stable semver tag like v0.10.2."
  exit 1
fi

mapfile -t assets < <(jq -r '.assets[]?.name // empty' <<<"${release_json}")
printf 'Assets:\n%s\n' "${assets[@]:-<none>}"

required_assets=(
  latest.yml
  latest-mac.yml
  latest-linux.yml
)

for required in "${required_assets[@]}"; do
  if ! printf '%s\n' "${assets[@]:-}" | grep -Fxq "${required}"; then
    echo "::error::Latest stable release '${tag}' is missing updater feed asset '${required}'."
    exit 1
  fi
done

echo "Latest stable release '${tag}' carries the full updater feed."
