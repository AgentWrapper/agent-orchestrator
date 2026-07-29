# T11 (M6) — CI, assinatura e release Tauri

## Objective
New release pipeline: build/sign/notarize Tauri artifacts on 4 native runners, generate per-channel updater manifests, keep PR CI green with cargo checks.

## Files
Read: `.github/workflows/frontend-release.yml`, `feature-release.yml`, `frontend.yml`, `build-artifacts.yml`, `testing-build.yml`, `.github/actions/macos-signing-setup/action.yml`, `frontend/scripts/build-daemon.mjs`, `frontend/src-tauri/tauri.conf.json`.
Create: `.github/workflows/tauri-release.yml`, `frontend/scripts/tauri-manifest.mjs` (+ test), sidecar mode in `build-daemon.mjs` (`--sidecar` flag emitting `src-tauri/binaries/ao-<target-triple>[.exe]`).
Modify: `frontend.yml` (add rust job), `tauri.conf.json` (bundle.externalBin `binaries/ao`, updater plugin pubkey placeholder + endpoints), `.github/actions/macos-signing-setup` (remap envs to Tauri conventions: APPLE_CERTIFICATE/APPLE_CERTIFICATE_PASSWORD/APPLE_SIGNING_IDENTITY; notarization APPLE_API_KEY = key ID, APPLE_API_ISSUER, APPLE_API_KEY_PATH = path to .p8).

## Steps
1. `build-daemon.mjs --sidecar`: map process.platform/arch → target triple (aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu); `CGO_ENABLED=0` on linux.
2. tauri-release.yml: matrix [macos-latest, macos-15-intel, windows-latest, ubuntu-latest]; steps: checkout → setup-node (npm cache) → setup-go (backend/go.mod) → dtolnay/rust-toolchain@stable → swatinem/rust-cache (workspaces frontend/src-tauri) → npm ci → `node scripts/build-daemon.mjs --sidecar` → macOS signing setup → `npx tauri build` with TAURI_SIGNING_PRIVATE_KEY/_PASSWORD env → upload artifacts + `.sig` files to the GitHub Release (`gh release upload`). Ubuntu system deps: libwebkit2gtk-4.1-dev, libayatana-appindicator3-dev, librsvg2-dev, patchelf.
3. Fan-in job: download all sigs/artifacts, `node scripts/tauri-manifest.mjs <dir> <version> <channel>` → `{version, pub_date, platforms:{"darwin-aarch64":{signature,url},"darwin-x86_64":...,"windows-x86_64":...,"linux-x86_64":...}}` → upload `latest.json` (channel-named for nightly/pr). Unit-test the generator with fixture sigs.
4. feature-release adaptation: same pipeline, prerelease tag `pr<N>`, manifest `pr-<N>.json`, keep the `<!-- ao-feature-build: {...} -->` marker in the release body.
5. frontend.yml: add `rust` job (fmt --check, clippy -D warnings, test; rust-cache; no bundling).
6. Environment `release` gate preserved from frontend-release.yml. Do NOT delete old workflows yet (M7).
7. Validate workflow syntax: `npx @redwoodjs/agent-ci run --all` if Docker available, else `actionlint` if installed, else careful YAML review (state which was used).

## Do NOT touch
Old workflows' contents (only add new files + the frontend.yml job); backend code; Electron config.

## Acceptance criteria
- New workflow files lint-clean; manifest generator tests pass (`node --test` or vitest, match repo style); `build-daemon.mjs --sidecar` produces `src-tauri/binaries/ao-<host-triple>` locally and `npx tauri build --debug --no-bundle` succeeds on this host using it.

## Return format
Files; pipeline shape; local build evidence; acceptance results; deviations.
