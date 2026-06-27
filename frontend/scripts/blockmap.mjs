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
// the feed yml. We deliberately do NOT surface blockMapSize: omitting it from
// the yml forces the client onto the sidecar differential path on every
// platform (verified against MacUpdater / NsisUpdater / AppImage).
export async function writeBlockmap(filePath) {
	const { sha512, size } = await buildBlockMap(filePath, "gzip", `${filePath}.blockmap`);
	return { sha512, size };
}
