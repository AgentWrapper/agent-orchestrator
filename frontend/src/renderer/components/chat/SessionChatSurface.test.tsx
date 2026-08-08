import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession } from "../../types/workspace";
import { useUiStore } from "../../stores/ui-store";
import { workspaceQueryKey } from "../../hooks/useWorkspaceQuery";

const LINK = "http://localhost:5173";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
	apiClient: { POST: postMock },
}));

vi.mock("../../hooks/useConversation", () => ({
	useConversation: () => ({
		snapshot: { capabilities: [] },
		isLoading: false,
		unavailable: undefined,
		error: undefined,
		hasOlder: false,
		isLoadingOlder: false,
		loadOlder: vi.fn(),
	}),
	useConversationCommands: () => ({}),
	useConversationConfigOptions: () => ({ options: [] }),
	useConversationModels: () => ({ models: [] }),
	useConversationSkills: () => ({ skills: [] }),
	useStageAttachments: () => undefined,
	useWorkspaceFilePaths: () => ({ paths: [], truncated: false }),
}));

vi.mock("./ChatWorkspace", () => ({
	ChatWorkspace: ({ onLinkOpen }: { onLinkOpen?: (url: string) => void }) => (
		<button type="button" onClick={() => onLinkOpen?.(LINK)}>
			Open chat link
		</button>
	),
}));

import { SessionChatSurface } from "./SessionChatSurface";

const session = {
	id: "sess-1",
	workspaceId: "proj-1",
	workspaceName: "my-app",
	title: "chat worker",
	provider: "codex",
	kind: "worker",
	mode: "chat",
	status: "working",
	updatedAt: "2026-08-08T00:00:00Z",
	prs: [],
} satisfies WorkspaceSession;

function Wrapper({ client, children }: { client: QueryClient; children: ReactNode }) {
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	postMock.mockReset().mockResolvedValue({ data: {}, error: undefined });
	useUiStore.setState({ inspectorSessions: {} });
});

describe("SessionChatSurface link routing", () => {
	it("opens a plain Chat link in the active worker AO Browser", async () => {
		const user = userEvent.setup();
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

		render(
			<Wrapper client={queryClient}>
				<SessionChatSurface session={session} />
			</Wrapper>,
		);
		await user.click(screen.getByRole("button", { name: "Open chat link" }));

		expect(useUiStore.getState().inspectorSessions[session.id]).toMatchObject({
			isOpen: true,
			view: "browser",
		});
		expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/preview", {
			params: { path: { sessionId: session.id } },
			body: { url: LINK },
		});
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: workspaceQueryKey }));
	});
});
