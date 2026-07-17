import { beforeAll, describe, expect, it } from "vitest";
import type { DaemonStatus } from "../../shared/daemon-status";
import { i18n, initializeRendererI18n } from "../i18n";
import { daemonStatusMessage } from "./daemon-status";

describe("daemonStatusMessage", () => {
	beforeAll(async () => {
		await initializeRendererI18n("en");
	});

	it("ignores an English main-process message for a known semantic code", () => {
		const status: DaemonStatus = {
			state: "error",
			code: "remote_bad_password",
			message: "Connection password is invalid.",
		};

		expect(daemonStatusMessage(status, i18n.getFixedT("en"), "Fallback")).toBe("The connection password is incorrect.");
		expect(daemonStatusMessage(status, i18n.getFixedT("zh-CN"), "后备文案")).toBe("连接密码不正确。");
	});

	it("retranslates a safe external detail prefix without changing the detail", () => {
		const status: DaemonStatus = {
			state: "error",
			code: "daemon_unreachable",
			message: "connect ECONNREFUSED 192.168.2.220:3011",
		};

		expect(daemonStatusMessage(status, i18n.getFixedT("en"), "Fallback")).toBe(
			"Could not reach the AO daemon: connect ECONNREFUSED 192.168.2.220:3011",
		);
		expect(daemonStatusMessage(status, i18n.getFixedT("zh-CN"), "后备文案")).toBe(
			"无法连接 AO 守护进程：connect ECONNREFUSED 192.168.2.220:3011",
		);
	});

	it("filters credential-bearing external details", () => {
		const status: DaemonStatus = {
			state: "error",
			code: "spawn_failed",
			message: "Authorization: Bearer do-not-show",
		};

		const rendered = daemonStatusMessage(status, i18n.getFixedT("en"), "Fallback");
		expect(rendered).toBe("Could not start the AO daemon.");
		expect(rendered).not.toContain("do-not-show");
	});

	it("ignores a main-process identity diagnostic and renders only the current locale", () => {
		const status: DaemonStatus = {
			state: "error",
			code: "identity_mismatch",
			message:
				"Another AO daemon is already running from /srv/old; expected this checkout at /srv/current. Stop the other daemon before using this checkout.",
		};

		const rendered = daemonStatusMessage(status, i18n.getFixedT("zh-CN"), "后备文案");
		expect(rendered).toBe("响应的服务不是预期的 AO 守护进程。");
		expect(rendered).not.toContain("Another AO daemon");
		expect(rendered).not.toContain("/srv/old");
	});

	it("formats binary, exit, and HTTP failures from structured fields", () => {
		const t = i18n.getFixedT("en");

		expect(
			daemonStatusMessage(
				{ state: "error", code: "binary_missing", executablePath: "/Applications/AO/ao", message: "ignore me" },
				t,
				"Fallback",
			),
		).toBe("The AO daemon binary was not found at /Applications/AO/ao.");
		expect(
			daemonStatusMessage({ state: "stopped", code: "exited", signal: "SIGTERM", message: "ignore me" }, t, "Fallback"),
		).toBe("The AO daemon exited with signal SIGTERM.");
		expect(
			daemonStatusMessage({ state: "stopped", code: "exited", exitCode: 17, message: "ignore me" }, t, "Fallback"),
		).toBe("The AO daemon exited with code 17.");
		expect(
			daemonStatusMessage(
				{ state: "error", code: "remote_http_error", httpStatus: 503, message: "ignore me" },
				t,
				"Fallback",
			),
		).toBe("The remote AO server returned HTTP 503.");
	});

	it("uses the localized fallback plus safe detail for a future code", () => {
		const status = {
			state: "error",
			code: "future_daemon_failure",
			message: "socket closed by peer",
		} as unknown as DaemonStatus;

		expect(daemonStatusMessage(status, i18n.getFixedT("en"), "Could not continue")).toBe(
			"Could not continue: socket closed by peer",
		);
		expect(daemonStatusMessage(status, i18n.getFixedT("zh-CN"), "无法继续")).toBe("无法继续：socket closed by peer");
	});
});
