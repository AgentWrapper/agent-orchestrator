import { expect, test } from "vitest";
import { pairingPayload } from "./ConnectMobileModal";

test("QR payload never contains the password", () => {
	const s = pairingPayload("192.168.1.42", 3011);
	expect(JSON.parse(s)).toEqual({ v: 1, host: "192.168.1.42", port: 3011 });
	expect(s.toLowerCase()).not.toContain("password");
});
