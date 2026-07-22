export const minimumGoVersion = [1, 25, 7];

// Prerelease toolchains are deliberately rejected: this build requires the
// stable Go release declared in backend/go.mod or a later stable release.
export function parseGoVersion(value) {
	const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?(?![\w.])/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function meetsMinimumVersion(actual, minimum = minimumGoVersion) {
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	}
	return true;
}
