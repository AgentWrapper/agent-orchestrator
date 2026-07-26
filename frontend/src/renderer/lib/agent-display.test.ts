import { describe, expect, it } from "vitest";
import {
	agentTabLabel,
	detectAgentFromText,
	leftAlternateScreen,
	looksLikeShellPrompt,
	parseAgentProvider,
	shellTabPresentation,
} from "./agent-display";

describe("agentTabLabel", () => {
	it("shortens claude-code to claude", () => {
		expect(agentTabLabel("claude-code")).toBe("claude");
	});

	it("passes through most harness ids unchanged", () => {
		expect(agentTabLabel("codex")).toBe("codex");
		expect(agentTabLabel("cursor")).toBe("cursor");
		expect(agentTabLabel("opencode")).toBe("opencode");
	});
});

describe("parseAgentProvider", () => {
	it("maps claude alias and known ids", () => {
		expect(parseAgentProvider("claude")).toBe("claude-code");
		expect(parseAgentProvider("kimi")).toBe("kimi");
		expect(parseAgentProvider("nope")).toBeUndefined();
	});
});

describe("detectAgentFromText", () => {
	it("detects kimi welcome banner even with ansi", () => {
		expect(detectAgentFromText("\u001b[34mWelcome to Kimi Code!\u001b[0m")).toBe("kimi");
	});

	it("returns undefined for a plain prompt", () => {
		expect(detectAgentFromText("➜ agent-orchestrator git:(main)")).toBeUndefined();
	});

	it("ignores an agent name the user only typed at the prompt", () => {
		expect(detectAgentFromText("➜ agent-orchestrator git:(main) ✗ codex")).toBeUndefined();
	});
});

describe("looksLikeShellPrompt", () => {
	it("recognizes a themed prompt, with or without a half-typed command", () => {
		expect(looksLikeShellPrompt("Bye!\n➜ agent-orchestrator git:(main) ✗ ")).toBe(true);
		expect(looksLikeShellPrompt("➜ agent-orchestrator git:(main) ✗ codex")).toBe(true);
		expect(looksLikeShellPrompt("user@host ~/ws $ ")).toBe(true);
	});

	it("does not fire on agent output", () => {
		expect(looksLikeShellPrompt("╭─ Welcome to Kimi Code ─╮")).toBe(false);
	});
});

describe("leftAlternateScreen", () => {
	it("detects a full-screen TUI exiting", () => {
		expect(leftAlternateScreen("\u001b[?1049l")).toBe(true);
		expect(leftAlternateScreen("\u001b[?1049h")).toBe(false);
	});
});

describe("shellTabPresentation", () => {
	it("keeps a custom title even when an agent is detected", () => {
		expect(
			shellTabPresentation({ title: "deploy logs", workingDir: "/tmp/ws", detectedAgent: "kimi" }),
		).toEqual({ label: "deploy logs", provider: "kimi" });
	});

	it("swaps a default cwd title for the detected agent brand", () => {
		expect(
			shellTabPresentation({ title: "ws", workingDir: "/tmp/ws", detectedAgent: "kimi" }),
		).toEqual({ label: "kimi", provider: "kimi" });
	});

	it("follows the pane when a different agent starts", () => {
		expect(
			shellTabPresentation({ title: "kimi", workingDir: "/tmp/ws", detectedAgent: "codex" }),
		).toEqual({ label: "codex", provider: "codex" });
	});

	it("falls back to the cwd once the agent exits", () => {
		expect(shellTabPresentation({ title: "kimi", workingDir: "/tmp/ws" })).toEqual({ label: "ws" });
	});

	it("keeps a custom title for a plain shell", () => {
		expect(shellTabPresentation({ title: "deploy logs", workingDir: "/tmp/ws" })).toEqual({
			label: "deploy logs",
		});
	});
});
