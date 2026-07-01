import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

type Platform = NodeJS.Platform;

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return realpathSync.native(resolved);
	} catch {
		let current = resolved;
		const missingParts: string[] = [];
		while (!existsSync(current)) {
			const parent = path.dirname(current);
			if (parent === current) return resolved;
			missingParts.unshift(path.basename(current));
			current = parent;
		}
		try {
			return path.join(realpathSync.native(current), ...missingParts);
		} catch {
			return resolved;
		}
	}
}

export function pathIdentityKey(value: string, platform: Platform = process.platform): string {
	const canonical = canonicalPath(value);
	return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
	return pathIdentityKey(a, platform) === pathIdentityKey(b, platform);
}

export function pathInside(child: string, parent: string, platform: Platform = process.platform): boolean {
	const childKey = pathIdentityKey(child, platform);
	const parentKey = pathIdentityKey(parent, platform);
	return childKey === parentKey || childKey.startsWith(parentKey + path.sep);
}
