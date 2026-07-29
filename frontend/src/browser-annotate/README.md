# browser-annotate

Plain-JS `main.ts` is the Tauri port of `../annotate-preload.ts` (Electron's
isolated preload for the browser-panel annotation picker) — see the header
comment in `main.ts` for what it does and the globals the Rust host
(`frontend/src-tauri/src/browser/host.rs::browser_ensure`) wires up per
webview.

## Build step

`main.ts` is not consumed as source. `frontend/src-tauri/src/browser/host.rs`
embeds a pre-built, dependency-free IIFE bundle
(`frontend/src-tauri/src/browser/annotate-bundle.js`) via `include_str!`, and
passes it as the `initialization_script` for every child `browser-*`
webview. `cargo build` has no hook to invoke `vite` itself, so that bundle is
checked into git like any other generated-but-committed build artifact this
repo uses.

`vite.config.ts` in this directory builds `main.ts` into that bundle (a
`vite` lib build in `iife` format was chosen over a bespoke esbuild/tsc step
because `vite` is already a project dependency and its `iife` output is
exactly the shape `initialization_script()` wants: a single self-invoking
script, no `import`/`export` statements).

**After editing `main.ts` or `../shared/browser-annotations.ts`, regenerate
the bundle:**

```
npm run build:browser-annotate
```

and commit the resulting diff to `frontend/src-tauri/src/browser/annotate-bundle.js`
alongside your source change — the two must never drift, since Rust embeds
the bundle at compile time and has no way to detect a stale copy.
