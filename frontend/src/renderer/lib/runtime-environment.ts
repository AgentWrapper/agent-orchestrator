export function hasElectronBridge(): boolean {
	return typeof window !== "undefined" && Boolean(window.ao);
}
