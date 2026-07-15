import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDirectoryPickerDialog } from "./RemoteDirectoryPickerDialog";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
			return error.message;
		}
		return fallback;
	},
}));

function response(path: string, parent: string | null, directories: Array<{ name: string; path: string }>) {
	return { data: { path, parent, directories }, error: undefined };
}

function renderPicker(onSelect = vi.fn()) {
	render(
		<RemoteDirectoryPickerDialog
			disabled={false}
			kind="single_repo"
			onOpenChange={vi.fn()}
			onSelect={onSelect}
			open
		/>,
	);
	return onSelect;
}

beforeEach(() => {
	getMock.mockReset();
});

describe("RemoteDirectoryPickerDialog", () => {
	it("loads home without a query and navigates into a child and back to its parent", async () => {
		const user = userEvent.setup();
		getMock
			.mockResolvedValueOnce(response("/home/claude", "/home", [{ name: "code", path: "/home/claude/code" }]))
			.mockResolvedValueOnce(response("/home/claude/code", "/home/claude", []))
			.mockResolvedValueOnce(response("/home/claude", "/home", [{ name: "code", path: "/home/claude/code" }]));

		renderPicker();

		await waitFor(() =>
			expect(getMock).toHaveBeenNthCalledWith(1, "/api/v1/filesystem/directories", { params: undefined }),
		);
		await user.click(await screen.findByRole("button", { name: "Open code" }));
		await waitFor(() =>
			expect(getMock).toHaveBeenNthCalledWith(2, "/api/v1/filesystem/directories", {
				params: { query: { path: "/home/claude/code" } },
			}),
		);
		await user.click(screen.getByRole("button", { name: "Up" }));
		await waitFor(() =>
			expect(getMock).toHaveBeenNthCalledWith(3, "/api/v1/filesystem/directories", {
				params: { query: { path: "/home/claude" } },
			}),
		);
	});

	it("opens a typed absolute path", async () => {
		const user = userEvent.setup();
		getMock
			.mockResolvedValueOnce(response("/home/claude", "/home", []))
			.mockResolvedValueOnce(response("/srv/projects", "/srv", []));
		renderPicker();

		const pathInput = await screen.findByLabelText("Server path");
		await user.clear(pathInput);
		await user.type(pathInput, "/srv/projects");
		await user.click(screen.getByRole("button", { name: "Go" }));

		await waitFor(() =>
			expect(getMock).toHaveBeenLastCalledWith("/api/v1/filesystem/directories", {
				params: { query: { path: "/srv/projects" } },
			}),
		);
	});

	it("returns to an ancestor from the breadcrumbs", async () => {
		const user = userEvent.setup();
		getMock
			.mockResolvedValueOnce(response("/home/claude/code", "/home/claude", []))
			.mockResolvedValueOnce(response("/home", "/", [{ name: "claude", path: "/home/claude" }]));
		renderPicker();

		await user.click(await screen.findByRole("button", { name: "Go to /home" }));

		await waitFor(() =>
			expect(getMock).toHaveBeenLastCalledWith("/api/v1/filesystem/directories", {
				params: { query: { path: "/home" } },
			}),
		);
	});

	it("keeps API errors visible without closing the dialog", async () => {
		const user = userEvent.setup();
		getMock
			.mockResolvedValueOnce(
				response("/home/claude", "/home", [{ name: "private", path: "/home/claude/private" }]),
			)
			.mockResolvedValueOnce({ data: undefined, error: { message: "Permission denied" } });
		renderPicker();

		await user.click(await screen.findByRole("button", { name: "Open private" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
		expect(screen.getByRole("dialog", { name: "Browse server project folders" })).toBeInTheDocument();
	});

	it("disables selection when the edited path differs from the loaded directory", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValueOnce(response("/home/claude/code", "/home/claude", []));
		renderPicker();

		const selectButton = await screen.findByRole("button", { name: "Select this folder" });
		expect(selectButton).toBeEnabled();
		const pathInput = screen.getByLabelText("Server path");
		await user.clear(pathInput);
		await user.type(pathInput, "/srv/projects");

		expect(selectButton).toBeDisabled();
	});

	it("keeps selection disabled when navigation to the edited path fails", async () => {
		const user = userEvent.setup();
		getMock
			.mockResolvedValueOnce(response("/home/claude/code", "/home/claude", []))
			.mockResolvedValueOnce({ data: undefined, error: { message: "Permission denied" } });
		renderPicker();

		const pathInput = await screen.findByLabelText("Server path");
		await user.clear(pathInput);
		await user.type(pathInput, "/srv/private");
		await user.click(screen.getByRole("button", { name: "Go" }));
		await screen.findByRole("alert");

		expect(screen.getByRole("button", { name: "Select this folder" })).toBeDisabled();
	});

	it("shows a loading status while the directory request is pending", async () => {
		getMock.mockReturnValue(new Promise<never>(() => undefined));
		renderPicker();

		const status = await screen.findByRole("status");
		expect(status).toHaveTextContent("Loading folders...");
		expect(screen.getByRole("button", { name: "Select this folder" })).toBeDisabled();
	});

	it("selects the current folder", async () => {
		const user = userEvent.setup();
		const onSelect = vi.fn();
		getMock.mockResolvedValueOnce(response("/home/claude/code", "/home/claude", []));
		renderPicker(onSelect);

		await user.click(await screen.findByRole("button", { name: "Select this folder" }));

		expect(onSelect).toHaveBeenCalledWith("/home/claude/code");
	});
});
