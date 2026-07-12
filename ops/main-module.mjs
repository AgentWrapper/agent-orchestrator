import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMainModule(metaUrl, argvPath = process.argv[1]) {
	if (!argvPath) return false;
	if (metaUrl === pathToFileURL(argvPath).href) return true;
	// Deploy units execute through the release "current" symlink, so compare real paths too.
	try {
		return metaUrl === pathToFileURL(realpathSync(argvPath)).href;
	} catch {
		return false;
	}
}
