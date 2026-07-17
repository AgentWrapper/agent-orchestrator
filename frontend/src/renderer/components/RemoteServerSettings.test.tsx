import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import { RemoteServerDialog, RemoteServerSettingsSection } from "./RemoteServerSettings";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("RemoteServerSettings", () => {
	beforeEach(() => {
		window.ao!.remoteServer.isRemoteClient = vi.fn(async () => true);
		window.ao!.remoteServer.get = vi.fn(async () => null);
		window.ao!.remoteServer.revealPassword = vi.fn(async () => null);
		window.ao!.remoteServer.save = vi.fn(async () => ({ state: "ready" as const, port: 4317 }));
	});

	it("shows a blocking first-run dialog and submits host, port, and password", async () => {
		const user = userEvent.setup();
		const onConnected = vi.fn();
		render(<RemoteServerDialog open onConnected={onConnected} />);

		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
		await user.type(await screen.findByLabelText("Server IP or hostname"), "192.168.2.29");
		await user.clear(screen.getByLabelText("Port"));
		await user.type(screen.getByLabelText("Port"), "3011");
		await user.type(screen.getByLabelText("Connection password"), "secret");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		await waitFor(() =>
			expect(window.ao!.remoteServer.save).toHaveBeenCalledWith({
				host: "192.168.2.29",
				port: 3011,
				password: "secret",
			}),
		);
		expect(onConnected).toHaveBeenCalledWith({ state: "ready", port: 4317 });
	});

	it("keeps the dialog open and retranslates a semantic connection error", async () => {
		vi.mocked(window.ao!.remoteServer.save).mockResolvedValueOnce({
			state: "error",
			code: "remote_bad_password",
			message: "Connection password is invalid.",
		});
		const user = userEvent.setup();
		render(<RemoteServerDialog open />);

		await user.type(await screen.findByLabelText("Server IP or hostname"), "server");
		await user.type(screen.getByLabelText("Connection password"), "wrong");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("The connection password is incorrect.")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("连接密码不正确。")).toBeInTheDocument();
		expect(screen.queryByText("Connection password is invalid.")).not.toBeInTheDocument();
	});

	it("preserves a safe raw save failure while retranslating its prefix", async () => {
		vi.mocked(window.ao!.remoteServer.save).mockRejectedValueOnce(new Error("connect ECONNREFUSED 192.168.2.220:3011"));
		const user = userEvent.setup();
		render(<RemoteServerDialog open />);

		await user.type(await screen.findByLabelText("Server IP or hostname"), "server");
		await user.type(screen.getByLabelText("Connection password"), "wrong");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(
			await screen.findByText("Could not reach the AO daemon: connect ECONNREFUSED 192.168.2.220:3011"),
		).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法连接 AO 守护进程：connect ECONNREFUSED 192.168.2.220:3011")).toBeInTheDocument();
	});

	it("localizes a forwarder bind failure without exposing an app-owned English diagnostic", async () => {
		await initializeRendererI18n("zh-CN");
		vi.mocked(window.ao!.remoteServer.save).mockResolvedValueOnce({
			state: "error",
			code: "remote_forwarder_bind_failed",
			message: "Remote forwarder did not bind a TCP port",
		});
		const user = userEvent.setup();
		render(<RemoteServerDialog open />);

		await user.type(await screen.findByLabelText("服务器 IP 或主机名"), "server");
		await user.type(screen.getByLabelText("连接密码"), "secret");
		await user.click(screen.getByRole("button", { name: "连接" }));

		expect(await screen.findByText("无法启动本地远程转发器。")).toBeInTheDocument();
		expect(screen.queryByText("Remote forwarder did not bind a TCP port")).not.toBeInTheDocument();
	});

	it("loads a masked placeholder and retrieves the saved password only on explicit reveal", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		window.ao!.remoteServer.revealPassword = vi.fn(async () => "saved-secret");
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		expect(await screen.findByDisplayValue("claude.local")).toBeInTheDocument();
		expect(screen.getByDisplayValue("3011")).toBeInTheDocument();
		const password = screen.getByLabelText("Connection password");
		expect(password).toHaveValue("");
		expect(password).toHaveAttribute("placeholder", "********");
		expect(password).toHaveAttribute("type", "password");
		expect(window.ao!.remoteServer.revealPassword).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(password).toHaveValue("saved-secret"));
		expect(window.ao!.remoteServer.revealPassword).toHaveBeenCalledOnce();
		expect(password).toHaveAttribute("type", "text");
		expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save connection" })).toBeInTheDocument();
	});

	it("clears revealed saved plaintext on hide and retrieves it again on the next reveal", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		window.ao!.remoteServer.revealPassword = vi.fn(async () => "saved-secret");
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(password).toHaveValue("saved-secret"));
		await user.click(screen.getByRole("button", { name: "Hide password" }));
		expect(password).toHaveValue("");
		expect(password).toHaveAttribute("type", "password");

		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(window.ao!.remoteServer.revealPassword).toHaveBeenCalledTimes(2));
	});

	it("clears revealed saved plaintext when saving", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		window.ao!.remoteServer.revealPassword = vi.fn(async () => "saved-secret");
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(password).toHaveValue("saved-secret"));
		await user.click(screen.getByRole("button", { name: "Save connection" }));

		await waitFor(() => expect(password).toHaveValue(""));
		expect(window.ao!.remoteServer.save).toHaveBeenCalledWith({ host: "claude.local", port: 3011 });
	});

	it("does not retain revealed saved plaintext after unmount", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		window.ao!.remoteServer.revealPassword = vi.fn(async () => "saved-secret");
		const user = userEvent.setup();
		const first = render(<RemoteServerSettingsSection />);

		const firstPassword = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(firstPassword).toHaveValue("saved-secret"));
		first.unmount();

		render(<RemoteServerSettingsSection />);
		const secondPassword = await screen.findByLabelText("Connection password");
		expect(secondPassword).toHaveValue("");
		expect(secondPassword).toHaveAttribute("placeholder", "********");
		expect(window.ao!.remoteServer.revealPassword).toHaveBeenCalledOnce();
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(window.ao!.remoteServer.revealPassword).toHaveBeenCalledTimes(2));
	});

	it("omits an unchanged saved password when saving", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		await screen.findByDisplayValue("claude.local");
		await user.click(screen.getByRole("button", { name: "Save connection" }));

		await waitFor(() =>
			expect(window.ao!.remoteServer.save).toHaveBeenCalledWith({ host: "claude.local", port: 3011 }),
		);
	});

	it("keeps a newly typed replacement editable while masked", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.type(password, "replacement");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		expect(password).toHaveValue("replacement");
		expect(window.ao!.remoteServer.revealPassword).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Hide password" }));
		expect(password).toHaveValue("replacement");
	});

	it("ignores a late saved-password reveal after typing a replacement", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		const reveal = deferred<string | null>();
		window.ao!.remoteServer.revealPassword = vi.fn(() => reveal.promise);
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await waitFor(() => expect(window.ao!.remoteServer.revealPassword).toHaveBeenCalledOnce());
		await user.type(password, "replacement");
		await act(async () => {
			reveal.resolve("saved-secret");
			await reveal.promise;
		});

		await waitFor(() => expect(password).toHaveValue("replacement"));
	});

	it("ignores a late saved-password reveal after hiding", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		const reveal = deferred<string | null>();
		window.ao!.remoteServer.revealPassword = vi.fn(() => reveal.promise);
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await user.click(await screen.findByRole("button", { name: "Hide password" }));
		await act(async () => {
			reveal.resolve("saved-secret");
			await reveal.promise;
		});

		await waitFor(() => expect(password).toHaveValue(""));
		expect(password).toHaveAttribute("type", "password");
	});

	it("ignores a late saved-password reveal after saving", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		const reveal = deferred<string | null>();
		window.ao!.remoteServer.revealPassword = vi.fn(() => reveal.promise);
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));
		await user.click(screen.getByRole("button", { name: "Save connection" }));
		await waitFor(() => expect(window.ao!.remoteServer.save).toHaveBeenCalledOnce());
		await act(async () => {
			reveal.resolve("saved-secret");
			await reveal.promise;
		});

		await waitFor(() => expect(password).toHaveValue(""));
	});

	it("renders nothing in a normal local build", async () => {
		window.ao!.remoteServer.isRemoteClient = vi.fn(async () => false);
		const { container } = render(<RemoteServerSettingsSection />);

		await waitFor(() => expect(window.ao!.remoteServer.isRemoteClient).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("localizes remote settings while preserving host, port, and the masked password state", async () => {
		await initializeRendererI18n("zh-CN");
		window.ao!.remoteServer.get = vi.fn(async () => ({
			host: "gitlab.internal",
			port: 3011,
			passwordConfigured: true,
		}));
		render(<RemoteServerSettingsSection />);

		expect(await screen.findByText("远程服务器")).toBeInTheDocument();
		expect(await screen.findByLabelText("服务器 IP 或主机名")).toHaveValue("gitlab.internal");
		expect(screen.getByLabelText("端口")).toHaveValue(3011);
		const password = screen.getByLabelText("连接密码");
		expect(password).toHaveAttribute("type", "password");
		expect(password).toHaveAttribute("placeholder", "********");
		expect(window.ao!.remoteServer.revealPassword).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "显示密码" })).toBeInTheDocument();
	});

	it("updates a local load fallback after a live language change", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => Promise.reject(null));
		render(<RemoteServerSettingsSection />);

		expect(await screen.findByText("Could not load server settings.")).toBeInTheDocument();
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法加载服务器设置。")).toBeInTheDocument();
	});

	it("hides the field and updates a reveal fallback when secure storage rejects", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011, passwordConfigured: true }));
		window.ao!.remoteServer.revealPassword = vi.fn(async () => Promise.reject(null));
		const user = userEvent.setup();
		render(<RemoteServerSettingsSection />);

		const password = await screen.findByLabelText("Connection password");
		await user.click(screen.getByRole("button", { name: "Show password" }));

		expect(await screen.findByText("Could not reveal the saved password.")).toBeInTheDocument();
		expect(password).toHaveAttribute("type", "password");
		expect(password).toHaveValue("");
		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法显示已保存的密码。")).toBeInTheDocument();
	});
});
