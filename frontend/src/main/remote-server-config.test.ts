// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	REMOTE_SERVER_CONFIG_FILE_NAME,
	RemoteServerConfigError,
	readRemoteServerConfig,
	validateRemoteServerConfigInput,
	writeRemoteServerConfig,
	type ConfigCrypto,
} from "./remote-server-config";

const crypto: ConfigCrypto = {
	encrypt: (value) => Buffer.from(`sealed:${value}`, "utf8"),
	decrypt: (value) => value.toString("utf8").replace(/^sealed:/, ""),
};

describe("remote-server-config", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "ao-remote-server-config-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("normalizes a valid host and port", () => {
		expect(validateRemoteServerConfigInput({ host: " 192.168.2.29 ", port: 3011, password: "secret" })).toEqual({
			host: "192.168.2.29",
			port: 3011,
			password: "secret",
		});
	});

	it.each([
		[{ host: "", port: 3011, password: "secret" }, "remote_host_required"],
		[{ host: "server", port: 0, password: "secret" }, "remote_port_invalid"],
		[{ host: "server", port: 65536, password: "secret" }, "remote_port_invalid"],
		[{ host: "server", port: 30.5, password: "secret" }, "remote_port_invalid"],
		[{ host: "server", port: 3011, password: "" }, "remote_password_required"],
	] as const)("rejects invalid input with semantic code %#", (input, code) => {
		try {
			validateRemoteServerConfigInput(input);
			throw new Error("expected validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(RemoteServerConfigError);
			expect(error).toMatchObject({ code });
		}
	});

	it("returns null when no saved configuration exists", async () => {
		expect(await readRemoteServerConfig(dir, crypto)).toBeNull();
	});

	it("round-trips encrypted configuration without writing the plaintext password", async () => {
		const saved = await writeRemoteServerConfig(
			dir,
			{ host: " 192.168.2.29 ", port: 3011, password: "top-secret-password" },
			crypto,
		);

		expect(saved).toMatchObject({ host: "192.168.2.29", port: 3011, password: "top-secret-password" });
		expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);
		expect(await readRemoteServerConfig(dir, crypto)).toEqual(saved);

		const file = path.join(dir, REMOTE_SERVER_CONFIG_FILE_NAME);
		const raw = await readFile(file, "utf8");
		expect(raw).not.toContain("top-secret-password");
		expect(raw).toContain(Buffer.from("sealed:top-secret-password").toString("base64"));
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await readdir(dir)).toEqual([REMOTE_SERVER_CONFIG_FILE_NAME]);
	});

	it("returns null for corrupt saved configuration", async () => {
		await writeFile(path.join(dir, REMOTE_SERVER_CONFIG_FILE_NAME), "{not-json", "utf8");
		expect(await readRemoteServerConfig(dir, crypto)).toBeNull();
	});

	it("keeps the previous file when encryption fails", async () => {
		await writeRemoteServerConfig(dir, { host: "first", port: 3011, password: "first-password" }, crypto);
		const failingCrypto: ConfigCrypto = {
			encrypt: () => {
				throw new Error("secure storage unavailable");
			},
			decrypt: crypto.decrypt,
		};

		await expect(
			writeRemoteServerConfig(dir, { host: "second", port: 3012, password: "second-password" }, failingCrypto),
		).rejects.toThrow("secure storage unavailable");
		expect(await readRemoteServerConfig(dir, crypto)).toMatchObject({
			host: "first",
			port: 3011,
			password: "first-password",
		});
	});
});
