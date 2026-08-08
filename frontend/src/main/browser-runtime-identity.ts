export type BrowserRuntimeIdentity = {
	pid: number;
	startedAtMs: number;
	address: string;
	token: string;
};

export function sameBrowserRuntimeIdentity(a: BrowserRuntimeIdentity, b: BrowserRuntimeIdentity): boolean {
	return a.pid === b.pid && a.startedAtMs === b.startedAtMs && a.address === b.address && a.token === b.token;
}
