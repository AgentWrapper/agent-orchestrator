export function isLoopbackHostname(value: string): boolean {
	const hostname = value.toLowerCase().replace(/^\[(.*)\]$/, "$1");
	return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "::1";
}
