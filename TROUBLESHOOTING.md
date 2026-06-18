# Troubleshooting

## Node version is too old

**Symptom**: commands fail early with an engines error, unexpected startup crashes, or a local
Node version older than `20.18.3`.

**Root Cause**: AgentMesh requires Node `>=20.18.3`. A common failure mode on Windows is having an
older globally installed `node` while the repo and published packages expect a newer runtime.

**Fix**: upgrade Node, or run the repo with Node `20.18.3` explicitly.

```powershell
node --version

# If this is lower than v20.18.3, use Node 20.18.3 for repo-local commands:
npx -y node@20.18.3 "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.cjs" install
npx -y node@20.18.3 "$env:APPDATA\npm\node_modules\pnpm\bin\pnpm.cjs" build
npx -y node@20.18.3 packages/ao/bin/ao.js doctor
npx -y node@20.18.3 packages/ao/bin/ao.js start
```

## Legacy storage directory warning

**Symptom**: `ao start` succeeds but prints a warning that a legacy storage directory is present.

**Root Cause**: AgentMesh detected older runtime state that has not been migrated to the current
storage layout yet.

**Fix**: this warning is non-blocking. You can keep testing, then migrate when convenient:

```bash
ao migrate-storage
```

## Notifier credential warnings

**Symptom**: startup prints warnings for notifiers such as `discord`, `slack`, `webhook`,
`openclaw`, or `composio`.

**Root Cause**: those notifier plugins are enabled or discoverable, but their credentials are not
configured in the current environment.

**Fix**: this is also non-blocking for local dashboard and AgentMesh testing. Either ignore the
warnings during local validation, or configure only the notifiers you actually plan to use.

## DirectTerminal: posix_spawnp failed error

**Symptom**: Terminal in browser shows "Connected" but blank. WebSocket logs show:

```
[DirectTerminal] Failed to spawn PTY: Error: posix_spawnp failed.
```

**Root Cause**: node-pty prebuilt binaries are incompatible with your system.

**Fix**: Rebuild node-pty from source:

```bash
# From the repository root
cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
npx node-gyp rebuild
```

**Verification**:

```bash
# Test node-pty works
node -e "const pty = require('./node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty'); \
  const shell = pty.spawn('/bin/zsh', [], {name: 'xterm-256color', cols: 80, rows: 24, \
  cwd: process.env.HOME, env: process.env}); \
  shell.onData((d) => console.log('✅ OK')); \
  setTimeout(() => process.exit(0), 1000);"
```

**When this happens**:

- After `pnpm install` (uses cached prebuilts)
- After copying the repo to a new location
- On some macOS configurations with Homebrew Node

**Permanent fix**: The postinstall hook automatically rebuilds node-pty:

```bash
pnpm install  # Automatically rebuilds node-pty via postinstall hook
```

If you need to manually rebuild:

```bash
cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
npx node-gyp rebuild
```

## Other Issues

### Config file not found

**Symptom**: API returns 500 with "No agent-orchestrator.yaml found"

**Fix**: Ensure config exists in the directory where you run `ao start`, or symlink it:

```bash
ln -s /path/to/agent-orchestrator.yaml packages/web/agent-orchestrator.yaml
```
