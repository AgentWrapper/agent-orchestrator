// Parses the JSON payload encoded in the desktop's pairing QR code. Pure and
// dependency-free (no React/RN imports) so it typechecks trivially and needs
// no test runner in this package. The password is included so a single scan
// autofills everything; it is optional for back-compat with older QR codes
// (host+port only), in which case the user types the password by hand.
export function parsePairingPayload(raw: string): { host: string; port: string; password: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;

	if (obj.v !== 1) return null;

	const { host, port, password } = obj;
	if (typeof host !== "string" || host.length === 0) return null;
	if (typeof port !== "string" && typeof port !== "number") return null;

	return {
		host,
		port: String(port),
		password: typeof password === "string" ? password : "",
	};
}
