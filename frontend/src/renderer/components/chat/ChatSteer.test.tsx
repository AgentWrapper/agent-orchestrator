import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";
import { ChatWorkspace } from "./ChatWorkspace";
import { chatFixture } from "../../lib/chat-fixture";

// Steering sends guidance INTO the running turn instead of queueing behind it. The
// thing these tests protect is that the choice is legible: Enter changing meaning
// silently would be worse than the queueing it replaces.

describe("ChatComposer steering", () => {
	function composer(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
		return render(
			<ChatComposer onSend={vi.fn()} willQueue onSteer={vi.fn()} canSteer {...props} />,
		);
	}

	it("names both destinations while a turn is running", () => {
		composer();
		expect(screen.getByRole("button", { name: "Steer this turn" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Queue for next" })).toBeInTheDocument();
	});

	it("defaults Enter to the durable queue path used by ao send", () => {
		composer();
		expect(screen.getByText("Enter to queue")).toBeInTheDocument();
	});

	it("queues by default while a turn is running", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		composer({ onSteer, onSend });

		await userEvent.type(screen.getByRole("combobox"), "use the unit tests only{Enter}");
		expect(onSend).toHaveBeenCalledWith("use the unit tests only");
		expect(onSteer).not.toHaveBeenCalled();
	});

	it("steers once the user explicitly picks that", async () => {
		const onSteer = vi.fn().mockResolvedValue(undefined);
		const onSend = vi.fn();
		composer({ onSteer, onSend });

		await userEvent.click(screen.getByRole("button", { name: "Steer this turn" }));
		expect(screen.getByText("Enter to steer")).toBeInTheDocument();

		await userEvent.type(screen.getByRole("combobox"), "and then ship it{Enter}");
		expect(onSteer).toHaveBeenCalledWith("and then ship it");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("marks the armed destination for assistive tech", async () => {
		composer();
		expect(screen.getByRole("button", { name: "Queue for next" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await userEvent.click(screen.getByRole("button", { name: "Steer this turn" }));
		expect(screen.getByRole("button", { name: "Steer this turn" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("clears the composer only once the provider has taken the guidance", async () => {
		let settle = () => {};
		const onSteer = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		);
		composer({ onSteer });

		const field = screen.getByRole("combobox");
		await userEvent.click(screen.getByRole("button", { name: "Steer this turn" }));
		await userEvent.type(field, "stop after the tests{Enter}");
		// Still in the box: the turn is already running, so a refusal is a real
		// possibility and clearing early would lose what the user typed.
		expect(field).toHaveValue("stop after the tests");
		settle();
	});

	it("keeps the text when the steer is refused", async () => {
		const onSteer = vi.fn().mockRejectedValue(new Error("not steerable"));
		composer({ onSteer });
		const field = screen.getByRole("combobox");
		await userEvent.click(screen.getByRole("button", { name: "Steer this turn" }));
		await userEvent.type(field, "actually, skip it{Enter}");
		expect(field).toHaveValue("actually, skip it");
		expect(screen.getByRole("button", { name: "Queue for next" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("reports the daemon's refusal without a second message of its own", () => {
		composer({ steerRefusal: "A compaction turn is running. Try again once it finishes." });
		expect(screen.getByRole("status")).toHaveTextContent(/compaction turn is running/);
	});

	// Claude answers CHAT_STEER_UNSUPPORTED. A control that only ever fails is worse
	// than none, so the surface withdraws it rather than disabling it.
	it("offers nothing when the harness cannot steer", () => {
		composer({ onSteer: undefined, canSteer: false });
		expect(screen.queryByRole("button", { name: "Steer this turn" })).not.toBeInTheDocument();
		expect(screen.getByText("Enter to queue")).toBeInTheDocument();
	});

	it("offers nothing when no turn is in flight to steer", () => {
		composer({ canSteer: false, willQueue: false });
		expect(screen.queryByRole("button", { name: "Steer this turn" })).not.toBeInTheDocument();
		expect(screen.getByText("Enter to send")).toBeInTheDocument();
	});
});

describe("ChatWorkspace steering", () => {
	it("offers steering only into a turn the provider is actually running", () => {
		render(<ChatWorkspace snapshot={chatFixture} onSteer={vi.fn()} />);
		// The live fixture is mid-turn.
		expect(screen.getByRole("button", { name: "Steer this turn" })).toBeInTheDocument();
	});

	it("does not offer steering on a settled conversation", () => {
		render(
			<ChatWorkspace
				snapshot={{ ...chatFixture, turns: chatFixture.turns.map((t) => ({ ...t, state: "completed" as const })) }}
				onSteer={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Steer this turn" })).not.toBeInTheDocument();
	});

	// A queued turn has not reached the provider, so there is nothing to steer.
	it("does not offer steering into a turn that is only queued", () => {
		render(
			<ChatWorkspace
				snapshot={{
					...chatFixture,
					turns: chatFixture.turns.map((t) =>
						t.state === "running" ? { ...t, state: "queued" as const } : t,
					),
				}}
				onSteer={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Steer this turn" })).not.toBeInTheDocument();
	});

	it("renders a landed steer as the user's own words", () => {
		render(<ChatWorkspace snapshot={chatFixture} />);
		expect(screen.getByText(/Steered into the running turn/)).toBeInTheDocument();
	});
});
