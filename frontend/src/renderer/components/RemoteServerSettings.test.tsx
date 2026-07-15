import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteServerDialog, RemoteServerSettingsSection } from "./RemoteServerSettings";

describe("RemoteServerSettings", () => {
	beforeEach(() => {
		window.ao!.remoteServer.isRemoteClient = vi.fn(async () => true);
		window.ao!.remoteServer.get = vi.fn(async () => null);
		window.ao!.remoteServer.save = vi.fn(async () => ({ state: "ready" as const, port: 4317 }));
	});

	it("shows a blocking first-run dialog and submits host, port, and password", async () => {
		const user = userEvent.setup();
		const onConnected = vi.fn();
		render(<RemoteServerDialog open onConnected={onConnected} />);

		expect(await screen.findByRole("dialog")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
		await user.type(screen.getByLabelText("Server IP or hostname"), "192.168.2.29");
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

	it("loads the saved address in global settings without exposing the password", async () => {
		window.ao!.remoteServer.get = vi.fn(async () => ({ host: "claude.local", port: 3011 }));
		render(<RemoteServerSettingsSection />);

		expect(await screen.findByDisplayValue("claude.local")).toBeInTheDocument();
		expect(screen.getByDisplayValue("3011")).toBeInTheDocument();
		expect(screen.getByLabelText("Connection password")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Save connection" })).toBeInTheDocument();
	});

	it("renders nothing in a normal local build", async () => {
		window.ao!.remoteServer.isRemoteClient = vi.fn(async () => false);
		const { container } = render(<RemoteServerSettingsSection />);

		await waitFor(() => expect(window.ao!.remoteServer.isRemoteClient).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
