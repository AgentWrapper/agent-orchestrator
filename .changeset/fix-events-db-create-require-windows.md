---
"@aoagents/ao-core": patch
---

fix: use a filesystem path for `createRequire` in events-db so the dashboard boots when bundled

When `events-db.ts` is bundled into the Next.js server build, the bundler's `createRequire` shim only accepts absolute path strings and rejects `file://` URLs, so passing `import.meta.url` threw `ERR_INVALID_ARG_VALUE` and crashed the dashboard on startup. Convert the ESM URL with `fileURLToPath` before calling `createRequire`. Closes #2051.
