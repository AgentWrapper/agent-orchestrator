// frontend/scripts/blockmap.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// The ONE fragile import. app-builder-lib 26.x generates blockmaps in pure JS
// (there is no app-builder CLI / app-builder-bin in this tree). This internal
// path is pinned via package-lock; if it moves on a major upgrade, only this
// file changes. Smoke-tested by blockmap.test.mjs.
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");

// writeBlockmap creates "<filePath>.blockmap" (gzip sidecar) and returns the
// file's base64 sha512 + byte size, exactly as electron-updater reads them from
// the feed yml. We deliberately do NOT surface blockMapSize.
//
// What omitting blockMapSize actually does, per platform (verified against the
// published electron-updater@6.8.9 tarball, #3288 workstream 3):
//   win:   selects the sidecar differential path in NsisUpdater, via
//          AppUpdater.differentialDownloadInstaller. Sidecars are load-bearing.
//   linux: does NOT select a sidecar path. AppImageUpdater has no sidecar path
//          at all; it uses FileWithEmbeddedBlockMapDifferentialDownloader,
//          reading the blockmap from the AppImage tail and requiring
//          blockMapSize. Without it, linux differential updates are off
//          entirely and the sidecars we write for linux are read by nobody.
//   mac:   never calls writeBlockmap (see feed.mjs's hashFile), so MacUpdater
//          always takes the full zip download (#3034, #3151, #3267 decision 4).
export async function writeBlockmap(filePath) {
	const { sha512, size } = await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
	return { sha512, size };
}
