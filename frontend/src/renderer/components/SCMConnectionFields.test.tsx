import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteMock, getMock, postMock, putMock } = vi.hoisted(() => ({
	deleteMock: vi.fn(),
	getMock: vi.fn(),
	postMock: vi.fn(),
	putMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		DELETE: deleteMock,
		GET: getMock,
		POST: postMock,
		PUT: putMock,
	},
	apiErrorCode: (error: unknown) =>
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code: unknown }).code)
			: undefined,
	apiErrorMessage: (error: unknown) =>
		typeof error === "object" && error !== null && "message" in error
			? String((error as { message: unknown }).message)
			: "Request failed",
}));

import { SCMConnectionFields, type SCMSelection } from "./SCMConnectionFields";
import { scmConnectionsQueryKey } from "../hooks/useSCMConnections";
import { initializeRendererI18n } from "../i18n";

const gitlabConnection = {
	id: "gitlab-work",
	provider: "gitlab" as const,
	displayName: "GitLab Work",
	webBaseUrl: "https://gitlab.example.com",
	apiBaseUrl: "https://gitlab.example.com/api/v4",
	credentialConfigured: true,
	status: "unknown" as const,
};

const gitlabBackupConnection = {
	...gitlabConnection,
	id: "gitlab-backup",
	displayName: "GitLab Backup",
	webBaseUrl: "https://gitlab-backup.example.com",
	apiBaseUrl: "https://gitlab-backup.example.com/api/v4",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function renderFields(
	initial: SCMSelection = { provider: "gitlab", connectionId: "gitlab-work", repo: "group/app" },
	onValidationChange?: (valid: boolean) => void,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	function Harness() {
		const [value, setValue] = useState(initial);
		return (
			<>
				<SCMConnectionFields
					value={value}
					origin="git@gitlab.example.com:group/app.git"
					onChange={setValue}
					onValidationChange={onValidationChange}
				/>
				<button
					type="button"
					hidden
					data-testid="select-backup"
					onClick={() => setValue({ ...value, connectionId: "gitlab-backup" })}
				/>
				<output data-testid="selection">{JSON.stringify(value)}</output>
			</>
		);
	}
	render(
		<QueryClientProvider client={queryClient}>
			<Harness />
		</QueryClientProvider>,
	);
	return queryClient;
}

async function chooseOption(trigger: HTMLElement, optionName: string) {
	await userEvent.click(trigger);
	await userEvent.click(await screen.findByRole("option", { name: optionName }));
}

beforeEach(() => {
	deleteMock.mockReset();
	getMock.mockReset();
	postMock.mockReset();
	putMock.mockReset();
	getMock.mockResolvedValue({ data: { connections: [gitlabConnection] }, error: undefined });
	deleteMock.mockResolvedValue({ error: undefined });
});

afterEach(async () => {
	cleanup();
	await initializeRendererI18n("en");
});

describe("SCMConnectionFields", () => {
	it("localizes controls while preserving provider, connection, repository, and URL values", async () => {
		await initializeRendererI18n("zh-CN");
		renderFields();
		await screen.findByText("https://gitlab.example.com");

		expect(screen.getByRole("combobox", { name: "提供商" })).toHaveTextContent("GitLab");
		expect(screen.getByRole("combobox", { name: "连接" })).toHaveTextContent("GitLab Work");
		expect(screen.getByLabelText("仓库")).toHaveValue("group/app");
		expect(screen.getByText("https://gitlab.example.com")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "编辑 GitLab Work" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "测试连接" })).toBeInTheDocument();
	});

	it("masks a replacement token, reveals only the current input, then keeps it out of query cache", async () => {
		const queryClient = renderFields();
		queryClient.setQueryData(["scm-capabilities", "gitlab-work", "group/app"], { read: true, write: true });
		putMock.mockResolvedValue({
			data: { connection: { ...gitlabConnection, status: "unknown" } },
			error: undefined,
		});

		await userEvent.click(await screen.findByRole("button", { name: "Edit GitLab Work" }));
		const token = screen.getByLabelText("Access token");
		expect(token).toHaveAttribute("type", "password");
		expect(token).toHaveAttribute("placeholder", "********");
		expect(screen.getByText("Configured")).toBeInTheDocument();

		await userEvent.type(token, "replacement-token");
		await userEvent.click(screen.getByRole("button", { name: "Show access token" }));
		expect(token).toHaveAttribute("type", "text");
		expect(token).toHaveValue("replacement-token");

		await act(async () => {
			await initializeRendererI18n("zh-CN");
		});
		expect(screen.getByLabelText("访问令牌")).toHaveValue("replacement-token");
		expect(screen.getByLabelText("访问令牌")).toHaveAttribute("type", "text");
		expect(JSON.stringify(queryClient.getQueryData(scmConnectionsQueryKey))).not.toContain("replacement-token");

		await userEvent.click(screen.getByRole("button", { name: "保存连接" }));

		await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
		expect(putMock).toHaveBeenCalledWith("/api/v1/scm/connections/{id}", {
			params: { path: { id: "gitlab-work" } },
			body: {
				provider: "gitlab",
				displayName: "GitLab Work",
				webBaseUrl: "https://gitlab.example.com",
				apiBaseUrl: "https://gitlab.example.com/api/v4",
				token: "replacement-token",
			},
		});
		expect(JSON.stringify(queryClient.getQueryData(scmConnectionsQueryKey))).not.toContain("replacement-token");
		expect(queryClient.getQueryData(["scm-capabilities", "gitlab-work", "group/app"])).toBeUndefined();
	});

	it("locks every connection editor control while a save is pending", async () => {
		const pending = deferred<{
			data: { connection: typeof gitlabConnection };
			error: undefined;
		}>();
		putMock.mockReturnValueOnce(pending.promise);
		renderFields();

		await userEvent.click(await screen.findByRole("button", { name: "Edit GitLab Work" }));
		await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
		await waitFor(() => expect(putMock).toHaveBeenCalledOnce());

		for (const label of ["Connection name", "Connection ID", "Instance address", "API address", "Access token"]) {
			expect(screen.getByLabelText(label)).toBeDisabled();
		}
		for (const name of [
			"Close connection dialog",
			"Show access token",
			"Replace",
			"Remove credential",
			"Delete",
			"Cancel",
		]) {
			expect(screen.getByRole("button", { name })).toBeDisabled();
		}

		await act(async () => {
			pending.resolve({ data: { connection: gitlabConnection }, error: undefined });
			await pending.promise;
		});
	});

	it("ignores an old save completion after the editor switches to another connection", async () => {
		getMock.mockResolvedValue({
			data: { connections: [gitlabConnection, gitlabBackupConnection] },
			error: undefined,
		});
		const pending = deferred<{
			data: { connection: typeof gitlabConnection };
			error: undefined;
		}>();
		putMock.mockReturnValueOnce(pending.promise);
		renderFields();

		await userEvent.click(await screen.findByRole("button", { name: "Edit GitLab Work" }));
		await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
		await waitFor(() => expect(putMock).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByTestId("select-backup"));
		await waitFor(() => expect(screen.getByLabelText("Connection name")).toHaveValue("GitLab Backup"));

		await act(async () => {
			pending.resolve({ data: { connection: gitlabConnection }, error: undefined });
			await pending.promise;
		});

		expect(screen.getByTestId("selection")).toHaveTextContent('"connectionId":"gitlab-backup"');
		expect(screen.getByRole("dialog", { name: "Edit connection" })).toBeInTheDocument();
		expect(screen.getByLabelText("Connection name")).toHaveValue("GitLab Backup");
	});

	it("creates a self-hosted GitLab connection with a derived API URL", async () => {
		renderFields({ provider: "gitlab", connectionId: "", repo: "group/subgroup/app" });
		postMock.mockResolvedValue({
			data: {
				connection: {
					...gitlabConnection,
					id: "gitlab-main",
					displayName: "Main GitLab",
				},
			},
			error: undefined,
		});

		await userEvent.click(await screen.findByRole("button", { name: "Create SCM connection" }));
		await userEvent.type(screen.getByLabelText("Connection name"), "Main GitLab");
		await userEvent.clear(screen.getByLabelText("Connection ID"));
		await userEvent.type(screen.getByLabelText("Connection ID"), "gitlab-main");
		await userEvent.clear(screen.getByLabelText("Instance address"));
		await userEvent.type(screen.getByLabelText("Instance address"), "https://gitlab.internal");
		expect(screen.getByLabelText("API address")).toHaveValue("https://gitlab.internal/api/v4");
		await userEvent.type(screen.getByLabelText("Access token"), "new-token");
		await userEvent.click(screen.getByRole("button", { name: "Save connection" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/scm/connections", {
			body: {
				id: "gitlab-main",
				provider: "gitlab",
				displayName: "Main GitLab",
				webBaseUrl: "https://gitlab.internal",
				apiBaseUrl: "https://gitlab.internal/api/v4",
				token: "new-token",
			},
		});
		expect(screen.getByTestId("selection")).toHaveTextContent('"connectionId":"gitlab-main"');
	});

	it("tests the selected connection against the current repository and reports capabilities", async () => {
		const queryClient = renderFields();
		postMock.mockResolvedValue({
			data: {
				result: {
					status: "connected",
					identity: { username: "alice", displayName: "Alice" },
					capabilities: { read: true, write: false },
				},
			},
			error: undefined,
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(postMock).toHaveBeenCalledWith("/api/v1/scm/connections/{id}/test", {
			params: { path: { id: "gitlab-work" } },
			body: { repository: "group/app" },
		});
		expect(await screen.findByText("Connected as alice")).toBeInTheDocument();
		expect(screen.getByText("Read access")).toBeInTheDocument();
		expect(screen.getByText("No write access")).toBeInTheDocument();
		expect(queryClient.getQueryData(["scm-capabilities", "gitlab-work", "group/app"])).toEqual({
			read: true,
			write: false,
		});
	});

	it("keeps selection project-level and invalidates a test when provider or repository changes", async () => {
		const onValidationChange = vi.fn();
		renderFields(undefined, onValidationChange);
		postMock.mockResolvedValue({
			data: {
				result: {
					status: "connected",
					identity: { username: "raw-user" },
					capabilities: { read: true, write: true },
				},
			},
			error: undefined,
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
		expect(await screen.findByText("Connected as raw-user")).toBeInTheDocument();
		await waitFor(() => expect(onValidationChange).toHaveBeenLastCalledWith(true));

		await userEvent.type(screen.getByLabelText("Repository"), "-next");
		expect(screen.queryByText("Connected as raw-user")).not.toBeInTheDocument();
		await waitFor(() => expect(onValidationChange).toHaveBeenLastCalledWith(false));

		await chooseOption(screen.getByRole("combobox", { name: "Provider" }), "GitHub");
		expect(screen.getByTestId("selection")).toHaveTextContent(
			JSON.stringify({ provider: "github", connectionId: "github-default", repo: "" }),
		);
		expect(screen.getByText("Built-in GitHub connection")).toBeInTheDocument();
	});

	it("locks the project SCM selection while a connection test is pending", async () => {
		const pending = deferred<{
			data: {
				result: {
					status: "connected";
					identity: { username: string };
					capabilities: { read: boolean; write: boolean };
				};
			};
			error: undefined;
		}>();
		postMock.mockReturnValueOnce(pending.promise);
		const onValidationChange = vi.fn();
		renderFields(undefined, onValidationChange);

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
		await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
		expect(screen.getByRole("combobox", { name: "Connection" })).toBeDisabled();
		expect(screen.getByLabelText("Repository")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Create SCM connection" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Edit GitLab Work" })).toBeDisabled();

		pending.resolve({
			data: {
				result: {
					status: "connected",
					identity: { username: "repo-a-user" },
					capabilities: { read: true, write: true },
				},
			},
			error: undefined,
		});

		expect(await screen.findByText("Connected as repo-a-user")).toBeInTheDocument();
		await waitFor(() => expect(onValidationChange).toHaveBeenLastCalledWith(true));
		expect(screen.getByLabelText("Repository")).toBeEnabled();
	});

	it("clears cached repository capabilities when a connection test fails", async () => {
		const queryClient = renderFields();
		queryClient.setQueryData(["scm-capabilities", "gitlab-work", "group/app"], { read: true, write: true });
		postMock.mockResolvedValue({
			data: undefined,
			error: { code: "SCM_AUTH_FAILED", message: "SCM authentication failed" },
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

		expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
		expect(queryClient.getQueryData(["scm-capabilities", "gitlab-work", "group/app"])).toBeUndefined();
	});

	it("shows a structured authentication failure without exposing provider response bodies", async () => {
		renderFields();
		postMock.mockResolvedValue({
			data: undefined,
			error: { code: "SCM_AUTH_FAILED", message: "SCM authentication failed" },
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

		const status = (await screen.findByText("Unauthorized")).closest('[role="status"]');
		expect(status).toHaveTextContent("Unauthorized");
		expect(status).toHaveTextContent("Source control authentication failed");

		await act(async () => {
			await initializeRendererI18n("zh-CN");
		});
		expect(status).toHaveTextContent("未授权");
		expect(status).toHaveTextContent("代码托管身份验证失败");
		expect(status).not.toHaveTextContent("Source control authentication failed");
	});

	it("keeps an unknown safe test detail intact instead of parsing a trailing code", async () => {
		renderFields();
		postMock.mockResolvedValue({
			data: undefined,
			error: { code: "CUSTOM_FAILURE", message: "safe server detail (CUSTOM_FAILURE)" },
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

		const status = (await screen.findByText("Connection failed")).closest('[role="status"]');
		expect(status).toHaveTextContent("Connection failed");
		expect(status).toHaveTextContent("safe server detail (CUSTOM_FAILURE)");
	});

	it("renders connection query failures from the current locale instead of a cached message", async () => {
		getMock.mockResolvedValue({ data: undefined, error: { message: "cached English connection failure" } });
		renderFields();

		expect(await screen.findByText("Could not load connections", {}, { timeout: 3_000 })).toBeInTheDocument();
		expect(screen.queryByText("cached English connection failure")).not.toBeInTheDocument();

		await act(async () => {
			await initializeRendererI18n("zh-CN");
		});
		expect(screen.getByText("无法加载连接")).toBeInTheDocument();
	});

	it("keeps project validation blocked when the connection has no credential", async () => {
		const onValidationChange = vi.fn();
		renderFields({ provider: "gitlab", connectionId: "gitlab-work", repo: "group/app" }, onValidationChange);
		postMock.mockResolvedValue({
			data: {
				result: {
					status: "missing_credential",
					identity: { username: "" },
					capabilities: { read: false, write: false },
				},
			},
			error: undefined,
		});

		await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));

		expect(await screen.findByText("Missing credential")).toBeInTheDocument();
		await waitFor(() => expect(onValidationChange).toHaveBeenLastCalledWith(false));
	});
});
