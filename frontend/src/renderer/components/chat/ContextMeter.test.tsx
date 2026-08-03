import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextMeter } from "./ContextMeter";
import type { ConversationRateLimits, ConversationUsage } from "../../types/conversation";

// The behaviour under test is the threshold encoding, because that is what carries
// the meaning: a user glances at the fill and the colour, and only reads the digits
// if something looks wrong. The numbers here are the real ones a live codex
// app-server reported (18055 of a 258400 window; a pro account at 71% of a 7 day
// rate limit window).

function usage(over: Partial<ConversationUsage> = {}): ConversationUsage {
	return {
		contextUsed: 18055,
		contextWindow: 258400,
		inputTokens: 18050,
		outputTokens: 5,
		cachedTokens: 11008,
		totalTokens: 18055,
		...over,
	};
}

function limits(over: Partial<ConversationRateLimits> = {}): ConversationRateLimits {
	return {
		primaryUsedPercent: 71,
		secondaryUsedPercent: -1,
		primaryResetsInSeconds: 490444,
		planLabel: "pro",
		...over,
	};
}

/** The fill element inside the track, whose width and colour are the encoding. */
function fill(): HTMLElement {
	const inner = screen.getByRole("progressbar").firstElementChild?.firstElementChild;
	if (!inner) throw new Error("meter has no fill element");
	return inner as HTMLElement;
}

describe("ContextMeter", () => {
	it("reports fullness as a fraction of the window, not a bare token count", () => {
		render(<ContextMeter usage={usage()} />);
		// 18055/258400 is 7%. The old header showed "18,055 tokens", which cannot
		// tell a user whether the conversation is nearly done.
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "7");
		expect(screen.getByText("7%")).toBeInTheDocument();
		expect(screen.queryByText(/18,055 tokens/)).not.toBeInTheDocument();
	});

	it("encodes fullness in the fill width as well as the number", () => {
		render(<ContextMeter usage={usage({ contextUsed: 129200 })} />);
		expect(fill().style.width).toBe("50%");
	});

	it("keeps a nearly-empty conversation's fill visible rather than zero-width", () => {
		render(<ContextMeter usage={usage({ contextUsed: 100 })} />);
		// A hairline still reads as "a meter that is nearly empty"; a zero-width fill
		// reads as a broken component.
		expect(fill().style.width).toBe("2%");
	});

	describe("threshold colours", () => {
		it("uses the AO logo accent below 70%", () => {
			render(<ContextMeter usage={usage({ contextUsed: 172_000 })} />);
			expect(fill().className).toContain("bg-logo-accent");
		});

		it("shifts to the needs-you token from 70%", () => {
			// Exactly at the boundary, which must warn rather than stay normal.
			render(<ContextMeter usage={usage({ contextUsed: 180_880 })} />);
			expect(fill().className).toContain("bg-status-needs-you");
			expect(screen.getByText("70%").className).toContain("text-status-needs-you");
		});

		it("shifts to the exited token from 90%, where the next turn is at risk", () => {
			render(<ContextMeter usage={usage({ contextUsed: 232_560 })} />);
			expect(fill().className).toContain("bg-status-exited");
			expect(screen.getByText("90%").className).toContain("text-status-exited");
		});
	});

	it("clamps a provider that overreports past its own window", () => {
		render(<ContextMeter usage={usage({ contextUsed: 300_000 })} />);
		// Full, not overflowing the track and not claiming 116%.
		expect(fill().style.width).toBe("100%");
		expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
	});

	it("shows tokens without a meter when the provider states no context window", () => {
		render(<ContextMeter usage={usage({ contextWindow: 0, contextUsed: 900 })} />);
		// No window means no honest fullness. Drawing an empty bar would claim a
		// conversation is roomy when it might be nearly full.
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		expect(screen.getByText("900 tokens")).toBeInTheDocument();
	});

	it("renders nothing before the provider has reported anything", () => {
		const { container } = render(<ContextMeter />);
		// Absent is distinct from zero: an empty meter for an unreported conversation
		// would be a claim AO has not earned.
		expect(container).toBeEmptyDOMElement();
	});

	describe("quota warning", () => {
		it("stays hidden while the account has comfortable headroom", () => {
			render(<ContextMeter usage={usage()} rateLimits={limits({ primaryUsedPercent: 20 })} />);
			// A readout that is always present becomes furniture, and this one has to be
			// noticed on the day it matters.
			expect(screen.queryByText(/quota/)).not.toBeInTheDocument();
		});

		it("appears once the account is close to a wall", () => {
			render(<ContextMeter usage={usage()} rateLimits={limits({ primaryUsedPercent: 76 })} />);
			expect(screen.getByText("76% quota")).toBeInTheDocument();
		});

		it("escalates its colour past 90%, where turns start failing", () => {
			render(<ContextMeter usage={usage()} rateLimits={limits({ primaryUsedPercent: 94 })} />);
			expect(screen.getByText("94% quota").className).toContain("text-status-exited");
		});

		it("warns on the tighter of the two windows", () => {
			render(
				<ContextMeter
					usage={usage()}
					rateLimits={limits({ primaryUsedPercent: 30, secondaryUsedPercent: 88 })}
				/>,
			);
			// The tighter window is the one that will actually stop the next turn.
			expect(screen.getByText("88% quota")).toBeInTheDocument();
		});

		it("ignores a window the provider did not report", () => {
			render(
				<ContextMeter
					usage={usage()}
					rateLimits={limits({ primaryUsedPercent: -1, secondaryUsedPercent: -1 })}
				/>,
			);
			// Negative is the daemon's "not reported". Treating it as data would draw a
			// meter running backwards.
			expect(screen.queryByText(/quota/)).not.toBeInTheDocument();
		});

		it("warns on quota even when no usage has been reported yet", () => {
			// The startup rate-limit read lands before the first turn, so this is the
			// state a user sees when opening a conversation on a nearly-spent account:
			// exactly when the warning is most useful.
			render(<ContextMeter rateLimits={limits({ primaryUsedPercent: 97 })} />);
			expect(screen.getByText("97% quota")).toBeInTheDocument();
			expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		});
	});
});
