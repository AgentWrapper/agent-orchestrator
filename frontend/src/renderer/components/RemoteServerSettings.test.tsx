import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteServerDialog, RemoteServerSettingsSection } from "./RemoteServerSettings";

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

	it("keeps the dialog open and shows a connection error", async () => {
		vi.mocked(window.ao!.remoteServer.save).mockResolvedValueOnce({
			state: "error",
			code: "daemon_unreachable",
			message: "Connection password is invalid.",
		});
		const user = userEvent.setup();
		render(<RemoteServerDialog open />);

		await user.type(await screen.findByLabelText("Server IP or hostname"), "server");
		await user.type(screen.getByLabelText("Connection password"), "wrong");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("Connection password is invalid.")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
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

	it("renders nothing in a normal local build", async () => {
		window.ao!.remoteServer.isRemoteClient = vi.fn(async () => false);
		const { container } = render(<RemoteServerSettingsSection />);

		await waitFor(() => expect(window.ao!.remoteServer.isRemoteClient).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
