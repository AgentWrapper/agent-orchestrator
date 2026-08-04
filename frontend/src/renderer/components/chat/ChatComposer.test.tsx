import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import type { ChatSkill } from "../../types/conversation";

const SKILLS: ChatSkill[] = [
	{ name: "code-review", displayName: "code-review", description: "Review the diff", source: "user" },
	{ name: "review", displayName: "review", description: "Look it over", source: "repo" },
	{ name: "ship", displayName: "ship", description: "Open a PR", source: "user" },
];

const FILES = [
	"AGENTS.md",
	"backend/internal/ports/chat.go",
	"frontend/src/renderer/components/chat/ChatComposer.tsx",
];

function renderComposer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
	const onSend = vi.fn();
	render(<ChatComposer onSend={onSend} {...props} />);
	return { onSend, field: screen.getByLabelText("Message the agent") as HTMLTextAreaElement };
}

const png = (name = "shot.png") =>
	new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });

/* ---- the keyboard contract the composer already had ---------------------- */

describe("send keys", () => {
	it("separates secondary message tools from the primary send action", () => {
		render(
			<ChatComposer
				onSend={vi.fn()}
				onStageAttachments={vi.fn().mockResolvedValue([])}
				settings={<button type="button">Model</button>}
			/>,
		);

		const tools = screen.getByRole("group", { name: "Message tools" });
		expect(within(tools).getByRole("button", { name: "Attach an image" })).toBeInTheDocument();
		expect(within(tools).getByRole("button", { name: "Model" })).toBeInTheDocument();

		const actions = screen.getByRole("group", { name: "Send message controls" });
		expect(within(actions).getByRole("button", { name: "Send message" })).toBeInTheDocument();
		expect(within(actions).getByText("Enter to send")).toBeInTheDocument();
	});

	it("uses the AO logo palette for the send control", async () => {
		const { field } = renderComposer();
		const send = screen.getByRole("button", { name: "Send message" });
		expect(send).toHaveClass("bg-logo-accent", "text-logo-accent-foreground");

		await userEvent.type(field, "hello");
		expect(send).toBeEnabled();
		expect(send).toHaveClass("hover:bg-logo-accent-bright", "focus-visible:ring-logo-accent/45");
	});

	it("sends on Enter", async () => {
		const { onSend, field } = renderComposer();
		await userEvent.type(field, "hello");
		await userEvent.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("hello");
	});

	it("makes a newline on Shift+Enter and does not send", async () => {
		const { onSend, field } = renderComposer();
		await userEvent.type(field, "one");
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await userEvent.type(field, "two");
		expect(onSend).not.toHaveBeenCalled();
		expect(field.value).toBe("one\ntwo");
	});

	it("refuses to send an empty message: there is no keystroke concept here", async () => {
		const { onSend, field } = renderComposer();
		await userEvent.type(field, "   ");
		await userEvent.keyboard("{Enter}");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("clears the field after a send", async () => {
		const { field } = renderComposer();
		await userEvent.type(field, "hello");
		await userEvent.keyboard("{Enter}");
		expect(field.value).toBe("");
	});
});

/* ---- slash commands ------------------------------------------------------ */

describe("slash commands", () => {
	it("opens the skill menu on a leading slash", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/");
		expect(screen.getByRole("listbox")).toBeTruthy();
		expect(screen.getAllByRole("option")).toHaveLength(3);
	});

	it("filters as the user types", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/rev");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(2);
		// The prefix match leads; the mid-name match follows.
		expect(options[0]?.textContent).toContain("/review");
	});

	// The whole point of gating on the provider's answer: with nothing to offer,
	// the menu must not appear and the slash must behave like a character.
	it("leaves the slash an ordinary character when the provider reported no skills", async () => {
		const { onSend, field } = renderComposer({ skills: [] });
		await userEvent.type(field, "/rev");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(field.value).toBe("/rev");
		// And Enter still sends, rather than being consumed by a menu that is not there.
		await userEvent.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("/rev");
	});

	it("does not open on a slash that is not the start of the message", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "look in src/app");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("moves the highlight with the arrow keys and wraps", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/");

		const selected = () =>
			screen.getAllByRole("option").findIndex((node) => node.getAttribute("aria-selected") === "true");
		expect(selected()).toBe(0);
		await userEvent.keyboard("{ArrowDown}");
		expect(selected()).toBe(1);
		await userEvent.keyboard("{ArrowUp}{ArrowUp}");
		expect(selected()).toBe(2);
	});

	it("inserts the highlighted skill on Enter instead of sending", async () => {
		const { onSend, field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/rev");
		await userEvent.keyboard("{Enter}");

		expect(onSend).not.toHaveBeenCalled();
		expect(field.value).toBe("/review ");
		// The trigger is finished, so the menu closes rather than re-filtering what was
		// just inserted.
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("inserts on Tab as well", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/ship");
		await userEvent.keyboard("{Tab}");
		expect(field.value).toBe("/ship ");
	});

	it("closes on Escape and leaves the typed text alone", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/rev");
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(field.value).toBe("/rev");
	});

	// After a dismissal the composer must behave like a plain field again, or Enter
	// would appear to do nothing.
	it("sends on Enter after the menu was dismissed", async () => {
		const { onSend, field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/rev");
		await userEvent.keyboard("{Escape}");
		await userEvent.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("/rev");
	});

	it("selects with the mouse", async () => {
		const { field } = renderComposer({ skills: SKILLS });
		await userEvent.type(field, "/");
		await userEvent.click(screen.getByText("/ship"));
		expect(field.value).toBe("/ship ");
	});
});

/* ---- file mentions ------------------------------------------------------- */

describe("file mentions", () => {
	it("opens the file menu on an at-sign", async () => {
		const { field } = renderComposer({ filePaths: FILES });
		await userEvent.type(field, "@chat");
		const options = screen.getAllByRole("option");
		// Both files whose name starts with "chat" match; neither AGENTS.md does.
		expect(options).toHaveLength(2);
		// The row reads as a file name plus where it lives, not as one long path.
		expect(options[0]?.textContent).toContain("chat.go");
		expect(options[0]?.textContent).toContain("backend/internal/ports");
	});

	// The label is a name; what the agent has to resolve is the whole path.
	it("inserts the full path, without the sigil", async () => {
		const { field } = renderComposer({ filePaths: FILES });
		await userEvent.type(field, "look at @ChatComposer");
		await userEvent.keyboard("{Enter}");
		expect(field.value).toBe(
			"look at frontend/src/renderer/components/chat/ChatComposer.tsx ",
		);
	});

	it("sends the inserted path verbatim", async () => {
		const { onSend, field } = renderComposer({ filePaths: FILES });
		await userEvent.type(field, "@chat.go");
		await userEvent.keyboard("{Enter}");
		await userEvent.keyboard("{Enter}");
		expect(onSend).toHaveBeenCalledWith("backend/internal/ports/chat.go");
	});

	it("leaves the at-sign ordinary when there are no paths", async () => {
		const { field } = renderComposer({ filePaths: [] });
		await userEvent.type(field, "@chat");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(field.value).toBe("@chat");
	});

	it("says so when the worktree list was capped", async () => {
		const { field } = renderComposer({ filePaths: FILES, filePathsTruncated: true });
		await userEvent.type(field, "@chat");
		expect(screen.getByText(/Showing part of a large worktree/)).toBeTruthy();
	});
});

/* ---- attachments --------------------------------------------------------- */

describe("attachments", () => {
	// A control that cannot deliver must not be drawn: the fixture preview has no
	// worktree to write into.
	it("offers no attach control when there is nowhere to put the bytes", () => {
		renderComposer();
		expect(screen.queryByLabelText("Attach an image")).toBeNull();
	});

	it("offers the attach control when staging is wired", () => {
		renderComposer({ onStageAttachments: vi.fn() });
		expect(screen.getByLabelText("Attach an image")).toBeTruthy();
	});

	it("shows a removable chip per pasted image", async () => {
		const { field } = renderComposer({ onStageAttachments: vi.fn() });
		fireEvent.paste(field, { clipboardData: { files: [png("a.png"), png("b.png")], items: [] } });

		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
		expect(screen.getByLabelText("Remove image 1")).toBeTruthy();

		await userEvent.click(screen.getByLabelText("Remove image 1"));
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
	});

	it("ignores a paste that carries no file", async () => {
		const { field } = renderComposer({ onStageAttachments: vi.fn() });
		fireEvent.paste(field, { clipboardData: { files: [], items: [] } });
		await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
	});

	// The chip has to mean something: the bytes get written and the message names
	// the path the agent can open.
	it("stages the image and names the returned path in the message", async () => {
		const stage = vi.fn().mockResolvedValue([".ao/attachments/image-ab12cd34ef.png"]);
		const { onSend, field } = renderComposer({ onStageAttachments: stage });

		fireEvent.paste(field, { clipboardData: { files: [png()], items: [] } });
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));

		await userEvent.type(field, "what is wrong here");
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
		expect(stage.mock.calls[0]?.[0]).toEqual([
			{ mimeType: "image/png", data: expect.any(String) },
		]);
		await waitFor(() =>
			expect(onSend).toHaveBeenCalledWith(
				"what is wrong here\n\nAttached images (read these files in the workspace for visual context):\n- .ao/attachments/image-ab12cd34ef.png",
			),
		);
		// Consumed, so the next message does not silently resend them.
		await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
	});

	it("sends an image with no words, since the reference block carries the request", async () => {
		const stage = vi.fn().mockResolvedValue([".ao/attachments/image-1.png"]);
		const { onSend, field } = renderComposer({ onStageAttachments: stage });

		fireEvent.paste(field, { clipboardData: { files: [png()], items: [] } });
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
		// Sent from the field with no text typed at all.
		await userEvent.type(field, "{Enter}");

		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		expect(onSend.mock.calls[0]?.[0]).toBe(
			"Attached images (read these files in the workspace for visual context):\n- .ao/attachments/image-1.png",
		);
	});

	it("also sends native image bytes when the provider negotiated image prompts", async () => {
		const stage = vi.fn().mockResolvedValue([".ao/attachments/image-native.png"]);
		const { onSend, field } = renderComposer({ onStageAttachments: stage, nativeImages: true });

		fireEvent.paste(field, { clipboardData: { files: [png()], items: [] } });
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
		await userEvent.type(field, "inspect this{Enter}");

		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		expect(onSend.mock.calls[0]?.[0]).toContain(".ao/attachments/image-native.png");
		expect(onSend.mock.calls[0]?.[1]).toEqual([
			{ mimeType: "image/png", data: expect.any(String) },
		]);
	});

	// A message claiming an attachment the agent cannot open is worse than a refusal.
	it("sends nothing when staging fails, and says so", async () => {
		const stage = vi.fn().mockRejectedValue(new Error("disk full"));
		const { onSend, field } = renderComposer({ onStageAttachments: stage });

		fireEvent.paste(field, { clipboardData: { files: [png()], items: [] } });
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
		await userEvent.type(field, "look");
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
		expect(onSend).not.toHaveBeenCalled();
		// The images are still staged, so the user can retry rather than re-paste.
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		expect(field.value).toBe("look");
	});
});

/* ---- disabled and busy states ------------------------------------------- */

describe("unavailable states", () => {
	it("explains a stopped controller and refuses to send", async () => {
		const { onSend, field } = renderComposer({ disabled: true, skills: SKILLS });
		expect(field.placeholder).toContain("not connected");
		await userEvent.keyboard("{Enter}");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("says a mid-turn message will be held", () => {
		const { field } = renderComposer({ willQueue: true });
		expect(field.placeholder).toContain("sends when it finishes");
	});
});
