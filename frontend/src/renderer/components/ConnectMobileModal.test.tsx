import { expect, test } from "vitest";
import { pairingPayload } from "./ConnectMobileModal";

test("QR payload carries host, port, and password for one-scan connect", () => {
	const s = pairingPayload("192.168.1.42", 3011, "xKb1Z3A1");
	expect(JSON.parse(s)).toEqual({ v: 1, host: "192.168.1.42", port: 3011, password: "xKb1Z3A1" });
});
