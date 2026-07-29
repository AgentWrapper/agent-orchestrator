// Builds `main.ts` into a single dependency-free IIFE string that Rust
// embeds via `include_str!` (see
// `frontend/src-tauri/src/browser/host.rs::annotate_bundle`). A vite lib
// build (rather than a bespoke esbuild/tsc step) was chosen because it is
// already a project dependency, needs no new tooling, and its `iife` format
// output is exactly the shape `initialization_script()` wants: a single
// self-invoking script with no import/export statements. Run via
// `npm run build:browser-annotate`; the emitted file
// (`frontend/src-tauri/src/browser/annotate-bundle.js`) is checked into git
// like any other generated-but-committed build artifact this repo uses,
// since `cargo build` has no hook to invoke `vite` itself.
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		outDir: resolve(__dirname, "../../src-tauri/src/browser"),
		emptyOutDir: false,
		minify: false,
		lib: {
			entry: resolve(__dirname, "main.ts"),
			name: "AoBrowserAnnotate",
			formats: ["iife"],
			fileName: () => "annotate-bundle.js",
		},
	},
});
