import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./ChatWorkspace";
import { OriginMessage } from "./ChatTimelineItems";
import {
	chatFixture,
	chatFixtureEmpty,
	chatFixtureLongHistory,
	chatFixtureMcpFailed,
	chatFixtureSettled,
	chatFixtureThreadError,
} from "../../lib/chat-fixture";
import type { ConversationMessage, ConversationSnapshot } from "../../types/conversation";

const writeText = vi.fn(async (_text: string) => undefined);
const menuAction = vi.fn(async (_action: string) => undefined);

vi.mock("../../lib/bridge", () => ({
	aoBridge: {
		clipboard: { writeText: (text: string) => writeText(text) },
		menu: { action: (action: string) => menuAction(action) },
	},
}));

/** A refetch: identical content, all-new objects, which is what JSON parsing gives. */
function poll(snapshot: ConversationSnapshot): ConversationSnapshot {
	return structuredClone(snapshot);
}

/** jsdom has no layout, so the scroller's geometry has to be stated. */
function stubGeometry(node: HTMLElement, { scrollHeight, clientHeight, scrollTop }: {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
}) {
	Object.defineProperty(node, "scrollHeight", { configurable: true, value: scrollHeight });
	Object.defineProperty(node, "clientHeight", { configurable: true, value: clientHeight });
	Object.defineProperty(node, "scrollTop", { configurable: true, writable: true, value: scrollTop });
}

beforeEach(() => {
	writeText.mockClear();
	menuAction.mockClear();
});

describe("ChatWorkspace timeline", () => {
	it("uses the shared session topbar chrome for workers and orchestrators", () => {
		const view = render(<ChatWorkspace snapshot={chatFixture} sessionRole="worker" />);

		expect(screen.getByLabelText("Chat")).toHaveAttribute("data-session-role", "worker");
		expect(screen.getByTestId("session-workspace-topbar")).toBeInTheDocument();
		expect(screen.getByTestId("session-terminal-region")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: chatFixture.title })).toBeInTheDocument();

		view.rerender(<ChatWorkspace snapshot={chatFixture} sessionRole="orchestrator" />);

		expect(screen.getByLabelText("Chat")).toHaveAttribute("data-session-role", "orchestrator");
		expect(screen.getByTestId("session-workspace-topbar")).toBeInTheDocument();
		expect(screen.getByTestId("session-action-region")).toBeInTheDocument();
	});

	it("routes chat zoom buttons through the native zoom actions", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);

		fireEvent.click(screen.getByRole("button", { name: "Decrease font size" }));
		fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));

		expect(menuAction).toHaveBeenNthCalledWith(1, "view.zoomOut");
		expect(menuAction).toHaveBeenNthCalledWith(2, "view.zoomIn");
	});

	it("starts chat zoom at 12px and updates the displayed size with the zoom buttons", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);

		expect(screen.getByLabelText("Chat font size: 12 pixels")).toHaveTextContent("12px");

		fireEvent.click(screen.getByRole("button", { name: "Increase font size" }));
		expect(screen.getByLabelText("Chat font size: 13 pixels")).toHaveTextContent("13px");

		fireEvent.click(screen.getByRole("button", { name: "Decrease font size" }));
		expect(screen.getByLabelText("Chat font size: 12 pixels")).toHaveTextContent("12px");
	});

	it("keeps the composer aligned to the readable conversation width", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);
		const composer = screen.getByLabelText("Message the agent").closest("form");
		expect(composer?.parentElement).toHaveClass("mx-auto", "w-full", "max-w-3xl");
	});

	it("offers real recovery actions when the controller stops", async () => {
		const user = userEvent.setup();
		const resume = vi.fn();
		const openShell = vi.fn();
		render(
			<ChatWorkspace
				snapshot={{ ...chatFixtureSettled, controller: { state: "stopped" } }}
				onResumeAgent={resume}
				onOpenShell={openShell}
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent("The agent controller stopped");
		await user.click(screen.getByRole("button", { name: "Resume agent" }));
		await user.click(screen.getByRole("button", { name: "Open shell" }));
		expect(resume).toHaveBeenCalledOnce();
		expect(openShell).toHaveBeenCalledOnce();
	});

	it("does not report the intentional controller gap during an interface handoff as a crash", () => {
		render(
			<ChatWorkspace
				snapshot={{ ...chatFixtureSettled, controller: { state: "stopped" } }}
				controllerTransitioning
				onResumeAgent={vi.fn()}
				onOpenShell={vi.fn()}
			/>,
		);

		expect(screen.queryByText("The agent controller stopped")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Resume agent" })).not.toBeInTheDocument();
	});

	it("announces thread and tool-server failures", () => {
		const { rerender } = render(<ChatWorkspace snapshot={chatFixtureThreadError} />);
		expect(screen.getByRole("alert")).toHaveTextContent("thread hit an internal error");

		rerender(<ChatWorkspace snapshot={chatFixtureMcpFailed} />);
		expect(screen.getByRole("status")).toHaveTextContent(/tool servers? did not start/);
	});

	it("provides an interactive conversation minimap", () => {
		render(<ChatWorkspace snapshot={chatFixtureLongHistory(8)} />);
		const log = screen.getByRole("log");
		const scrollbar = screen.getByRole("scrollbar", { name: "Conversation scrollbar" });
		stubGeometry(log, { scrollHeight: 4000, clientHeight: 800, scrollTop: 1000 });
		stubGeometry(scrollbar, { scrollHeight: 800, clientHeight: 800, scrollTop: 0 });

		fireEvent.scroll(log);
		expect(scrollbar).toHaveAttribute("aria-valuenow", "31");
		const markers = Array.from(
			scrollbar.querySelectorAll<HTMLElement>("[data-chat-scroll-marker]"),
		);
		expect(markers.length).toBeGreaterThan(1);
		expect(Number.parseFloat(markers[1]!.style.top) - Number.parseFloat(markers[0]!.style.top)).toBeLessThanOrEqual(
			18,
		);

		fireEvent.wheel(scrollbar, { deltaY: 200 });
		expect(log.scrollTop).toBe(1200);
		expect(scrollbar).toHaveAttribute("aria-valuenow", "38");

		fireEvent.keyDown(scrollbar, { key: "End" });
		expect(log.scrollTop).toBe(3200);
		expect(scrollbar).toHaveAttribute("aria-valuenow", "100");
	});

	it("previews the request and response for a hovered conversation marker", () => {
		render(<ChatWorkspace snapshot={chatFixtureLongHistory(4)} />);
		const log = screen.getByRole("log");
		const scrollbar = screen.getByRole("scrollbar", { name: "Conversation scrollbar" });
		stubGeometry(log, { scrollHeight: 2400, clientHeight: 600, scrollTop: 0 });
		stubGeometry(scrollbar, { scrollHeight: 600, clientHeight: 600, scrollTop: 0 });
		fireEvent.scroll(log);

		const markers = Array.from(
			scrollbar.querySelectorAll<HTMLElement>("[data-chat-scroll-marker]"),
		);
		expect(markers.length).toBeGreaterThan(2);
		fireEvent.pointerEnter(markers[0]!);

		const preview = screen.getByRole("tooltip");
		expect(preview).toHaveTextContent("Wire the snapshot endpoint into the handler (round 1)");
		expect(preview).toHaveTextContent("Done. conversation now returns the durable snapshot");
		expect(markers[0]!.querySelector(".chat-scroll-marker")).toHaveClass(
			"chat-scroll-marker-active",
		);
		expect(markers[1]!.querySelector(".chat-scroll-marker")).toHaveClass(
			"chat-scroll-marker-adjacent",
		);

		fireEvent.pointerLeave(scrollbar);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("explains itself instead of showing an empty scroller", () => {
		render(<ChatWorkspace snapshot={chatFixtureEmpty} />);
		expect(screen.getByText("Start the conversation")).toBeInTheDocument();
		expect(screen.queryByRole("log")).not.toBeInTheDocument();
	});

	it("keeps a turn as one block, positioned by its first item", () => {
		// The fixture's automation relay carries sequence 8, in the middle of turn-2's
		// items. Reading strictly by sequence would split turn-2 around it; the rule is
		// that a turn takes the position of its first item and stays contiguous.
		render(<ChatWorkspace snapshot={chatFixture} />);
		const log = screen.getByRole("log");
		const text = log.textContent ?? "";
		const question = text.indexOf("Run the backend tests");
		const answer = text.indexOf("Tests are still running");
		const relay = text.indexOf("Checks failed on the base branch");

		expect(question).toBeGreaterThan(-1);
		expect(answer).toBeGreaterThan(question);
		expect(relay).toBeGreaterThan(answer);

		const relayCard = screen.getByText(/Checks failed on the base branch/).parentElement;
		expect(relayCard).toHaveClass("border-l-logo-accent/60");
		expect(relayCard?.querySelector("svg")).toHaveClass("text-logo-accent");
	});

	it("offers Jump to latest only once the reader has scrolled away from the bottom", async () => {
		const user = userEvent.setup();
		render(<ChatWorkspace snapshot={chatFixtureLongHistory(8)} />);
		const log = screen.getByRole("log");

		expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument();

		stubGeometry(log, { scrollHeight: 4000, clientHeight: 800, scrollTop: 100 });
		log.dispatchEvent(new Event("scroll"));
		const jump = await screen.findByRole("button", { name: /jump to latest/i });
		expect(jump).toHaveClass(
			"bg-raised",
			"dark:bg-raised",
			"hover:bg-surface",
			"dark:hover:bg-surface",
		);
		expect(jump).not.toHaveClass("dark:bg-transparent");
		expect(jump).not.toHaveClass("dark:hover:bg-input/30");

		// Taking the jump re-arms following, so the control retires itself.
		await user.click(jump);
		expect(log.scrollTop).toBe(4000);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /jump to latest/i })).not.toBeInTheDocument(),
		);
	});

	it("does not yank a reader who scrolled up when the next poll arrives", async () => {
		const snapshot = chatFixtureLongHistory(8);
		const { rerender } = render(<ChatWorkspace snapshot={snapshot} />);
		const log = screen.getByRole("log");

		stubGeometry(log, { scrollHeight: 4000, clientHeight: 800, scrollTop: 1200 });
		log.dispatchEvent(new Event("scroll"));
		await screen.findByRole("button", { name: /jump to latest/i });

		rerender(<ChatWorkspace snapshot={{ ...poll(snapshot), latestSequence: 999 }} />);
		expect(log.scrollTop).toBe(1200);
	});

	it("follows new output while the reader is already at the bottom", () => {
		const snapshot = chatFixtureLongHistory(8);
		const { rerender } = render(<ChatWorkspace snapshot={snapshot} />);
		const log = screen.getByRole("log");
		stubGeometry(log, { scrollHeight: 4000, clientHeight: 800, scrollTop: 0 });

		rerender(<ChatWorkspace snapshot={{ ...poll(snapshot), latestSequence: 999 }} />);
		expect(log.scrollTop).toBe(4000);
	});

	it("survives a poll without disturbing what the reader opened", async () => {
		const user = userEvent.setup();
		const snapshot = chatFixtureLongHistory(3);
		const { rerender } = render(<ChatWorkspace snapshot={snapshot} />);

		// A run of tool calls is collapsed; opening one is local state that a poll must
		// not reset, which is what remounting the subtree on every refetch would do.
		const run = screen.getAllByRole("button", { expanded: false })[0]!;
		await user.click(run);
		expect(run).toHaveAttribute("aria-expanded", "true");

		rerender(<ChatWorkspace snapshot={poll(snapshot)} />);
		expect(run).toHaveAttribute("aria-expanded", "true");
	});
});

describe("automation reports", () => {
	it("collapses a long report until the reader asks to expand it", async () => {
		const user = userEvent.setup();
		const source = chatFixture.items.find((item) => item.id === "m-4") as ConversationMessage;
		const message: ConversationMessage = {
			...source,
			text: `READ-ONLY follow-up report. ${"Adapter evidence and implementation details. ".repeat(20)}END OF REPORT`,
		};
		render(<OriginMessage message={message} />);

		expect(screen.getByRole("button", { name: "Show full report" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.queryByText(/END OF REPORT/)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Show full report" }));
		expect(screen.getByText(/END OF REPORT/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Hide report" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("keeps a short automation alert fully visible", () => {
		const message = chatFixture.items.find((item) => item.id === "m-4") as ConversationMessage;
		render(<OriginMessage message={message} />);
		expect(screen.getByText(/Checks failed on the base branch/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show full report" })).not.toBeInTheDocument();
	});
});

describe("ChatWorkspace message actions", () => {
	it("copies an assistant message as the markdown the agent wrote", async () => {
		const user = userEvent.setup();
		const snapshot = structuredClone(chatFixture);
		const finalIndex = snapshot.items.findIndex((item) => item.id === "m-2");
		const finalMessage = snapshot.items[finalIndex] as ConversationMessage;
		snapshot.items.splice(finalIndex, 0, {
			...finalMessage,
			id: "m-intermediate",
			sequence: finalMessage.sequence - 0.5,
			text: "Intermediate progress while the turn is still working.",
		});
		render(<ChatWorkspace snapshot={snapshot} />);

		const copies = screen.getAllByRole("button", { name: /copy message as markdown/i });
		expect(copies).toHaveLength(1);
		const copy = copies[0]!;
		await user.click(copy);

		expect(writeText).toHaveBeenCalledTimes(1);
		const copied = writeText.mock.calls[0]![0];
		// The stored text, fences and all — not a re-serialization of the rendered DOM.
		expect(copied).toContain("```go");
		expect(copied).toContain("func (m *Manager) Spawn");
		expect(copied).not.toContain("Intermediate progress");
	});

	it("offers no copy on a message that is still arriving", () => {
		const snapshot = structuredClone(chatFixture);
		snapshot.items = snapshot.items.filter((item) => item.sequence <= 12);
		render(<ChatWorkspace snapshot={snapshot} />);
		// The latest assistant message is mid-stream; half a message is not what the
		// reader means by "copy this".
		const streaming = screen.getByLabelText("still writing").closest("div");
		expect(streaming?.querySelector('[aria-label*="Copy message"]')).toBeNull();
	});

	it("does not leave a writing caret behind prose followed by tool activity", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);
		expect(screen.queryByLabelText("still writing")).not.toBeInTheDocument();
	});
});
