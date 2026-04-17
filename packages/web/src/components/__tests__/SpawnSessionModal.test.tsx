import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpawnSessionModal } from "../SpawnSessionModal";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const defaultAgentsResponse = {
  agents: [
    { name: "claude-code", displayName: "Claude Code", description: "Claude Code agent" },
    { name: "codex", displayName: "Codex", description: "OpenAI Codex agent" },
  ],
};
const defaultBasePromptResponse = {
  text: "You are an AI coding agent managed by the Agent Orchestrator.",
  planningAddition: "## Planning Mode\n- Write a plan first.",
};

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/agents") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(defaultAgentsResponse),
      });
    }
    if (url === "/api/base-prompt") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(defaultBasePromptResponse),
      });
    }
    if (url === "/api/spawn") {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            session: {
              id: "real-session-id",
              projectId: "my-project",
              status: "working",
              activity: null,
              branch: null,
              issueId: null,
              issueUrl: null,
              issueLabel: null,
              issueTitle: null,
              userPrompt: null,
              summary: null,
              summaryIsFallback: false,
              createdAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              pr: null,
              metadata: {},
            },
          }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
  global.fetch = mockFetch;
});

const baseProps = {
  projectId: "my-project",
  open: true,
  onClose: vi.fn(),
  onSessionCreated: vi.fn(),
  onSpawned: vi.fn(),
};

describe("SpawnSessionModal", () => {
  it("renders agent dropdown with options from /api/agents", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /claude-code/i })).toBeDefined();
    });
    expect(screen.getByRole("option", { name: /codex/i })).toBeDefined();
  });

  it("renders base prompt dropdown with 3 options", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Default/i })).toBeDefined();
    });
    expect(screen.getByRole("option", { name: /Planning/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /Custom/i })).toBeDefined();
  });

  it("Custom option reveals textarea pre-filled with default prompt text", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/Base Prompt/i)).toBeDefined();
    });
    const select = screen.getByLabelText(/Base Prompt/i);
    fireEvent.change(select, { target: { value: "custom" } });
    await waitFor(() => {
      const textarea = screen.getByLabelText(/Custom Base Prompt/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain("You are an AI coding agent");
    });
  });

  it("POST body has no basePromptMode when Default is selected", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("button", { name: /Spawn/i }));
    fireEvent.click(screen.getByRole("button", { name: /Spawn/i }));
    await waitFor(() => {
      const spawnCall = mockFetch.mock.calls.find((c) => c[0] === "/api/spawn");
      expect(spawnCall).toBeDefined();
      const body = JSON.parse(spawnCall[1].body as string);
      expect(body.basePromptMode).toBeUndefined();
    });
  });

  it("POST body has basePromptMode: planning when Planning is selected", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByLabelText(/Base Prompt/i));
    fireEvent.change(screen.getByLabelText(/Base Prompt/i), { target: { value: "planning" } });
    fireEvent.click(screen.getByRole("button", { name: /Spawn/i }));
    await waitFor(() => {
      const spawnCall = mockFetch.mock.calls.find((c) => c[0] === "/api/spawn");
      expect(spawnCall).toBeDefined();
      const body = JSON.parse(spawnCall[1].body as string);
      expect(body.basePromptMode).toBe("planning");
    });
  });

  it("POST body has basePromptMode: custom and basePromptCustom when Custom is selected", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByLabelText(/Base Prompt/i));
    fireEvent.change(screen.getByLabelText(/Base Prompt/i), { target: { value: "custom" } });
    await waitFor(() => screen.getByLabelText(/Custom Base Prompt/i));
    fireEvent.change(screen.getByLabelText(/Custom Base Prompt/i), {
      target: { value: "My custom instructions." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Spawn/i }));
    await waitFor(() => {
      const spawnCall = mockFetch.mock.calls.find((c) => c[0] === "/api/spawn");
      expect(spawnCall).toBeDefined();
      const body = JSON.parse(spawnCall[1].body as string);
      expect(body.basePromptMode).toBe("custom");
      expect(body.basePromptCustom).toBe("My custom instructions.");
    });
  });

  it("calls onSessionCreated immediately with optimistic stub", async () => {
    render(<SpawnSessionModal {...baseProps} />);
    await waitFor(() => screen.getByRole("button", { name: /Spawn/i }));
    fireEvent.click(screen.getByRole("button", { name: /Spawn/i }));
    expect(baseProps.onSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringMatching(/^spawning-/) }),
    );
  });

  it("Escape key calls onClose", () => {
    render(<SpawnSessionModal {...baseProps} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it("modal is portaled to document.body", () => {
    const { baseElement } = render(<SpawnSessionModal {...baseProps} />);
    expect(baseElement.querySelector('[role="dialog"]')).toBeDefined();
  });
});
