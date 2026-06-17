# Windows Development Issues

## .next Directory File Lock

On Windows, the `.next` directory (Next.js build cache) can get locked by Node.js processes, preventing cleanup and rebuilds. This is a known Windows file locking issue.

### Symptoms

- `pnpm build` fails with `EPERM: operation not permitted, unlink '.next/trace'`
- `rimraf .next` fails with file lock errors
- Dev server won't start due to locked build artifacts

### Solutions

#### Option 1: Use the cleanup script (Recommended)

The cleanup script in `packages/web/scripts/cleanup.mjs` handles the locked trace file gracefully:

```bash
pnpm --filter @aoagents/ao-web build
```

The script will skip the locked `.next/trace` file and continue with the build.

#### Option 2: Kill the specific Node process

Find which process is holding the lock:

```bash
# Check what's using port 3000
netstat -ano | findstr :3000

# Kill that specific PID
taskkill /F /PID <pid>
```

#### Option 3: Use handle.exe (Advanced)

Install [handle.exe](https://learn.microsoft.com/en-us/sysinternals/downloads/handle) from Sysinternals to see exactly which process is holding the file lock:

```bash
handle.exe "C:\path\to\.next\trace"
```

#### Option 4: Restart your computer

This is the nuclear option but guarantees all file locks are released.

### Prevention

- Always stop the dev server with Ctrl+C before building
- Don't run multiple dev servers on the same port
- Use `pnpm --filter @aoagents/ao-web build:skip-clean` to skip cleanup if you know the cache is valid

### Scripts Available

- `pnpm --filter @aoagents/ao-web kill-node-locks` - Diagnostic script to check for file locks (does not auto-kill processes)
- `pnpm --filter @aoagents/ao-web build:skip-clean` - Build without cleanup
- `pnpm --filter @aoagents/ao-web rebuild` - Force rebuild with cleanup
