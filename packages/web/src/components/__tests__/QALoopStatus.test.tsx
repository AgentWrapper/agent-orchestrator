import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QALoopStatus from "../QALoopStatus";

interface MockQAState {
  taskId: string;
  state: string;
  retryCount: number;
  maxRetries: number;
  lastQAResult?: {
    verdict: string;
    summary: string;
    findings: Array<{ severity: string; category: string; message: string }>;
    score?: number;
    timestamp: string;
  };
  lastTransition?: string;
}

function mockQA(qaState: MockQAState | null) {
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({ qaState }) } as Response),
  ) as unknown as typeof fetch;
}

describe("QALoopStatus", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a loading state on mount", () => {
    mockQA(null);
    render(<QALoopStatus taskId="TASK-1" />);
    expect(screen.getByText("Loading QA status...")).toBeInTheDocument();
  });

  it("renders an error message when the fetch fails", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as Response),
    ) as unknown as typeof fetch;

    render(<QALoopStatus taskId="TASK-1" />);

    expect(await screen.findByText("Failed to load QA status")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("renders the correct label for the current state", async () => {
    mockQA({ taskId: "TASK-1", state: "qa_running", retryCount: 0, maxRetries: 3 });
    render(<QALoopStatus taskId="TASK-1" />);
    expect(await screen.findByText("QA Running")).toBeInTheDocument();
  });

  it("shows the retry count when the task is in rework", async () => {
    mockQA({ taskId: "TASK-1", state: "rework", retryCount: 2, maxRetries: 3 });
    render(<QALoopStatus taskId="TASK-1" />);

    await screen.findByText("Rework in Progress");
    expect(screen.getAllByText("2/3").length).toBeGreaterThan(0);
  });

  it("shows QA findings when lastQAResult is present", async () => {
    mockQA({
      taskId: "TASK-1",
      state: "qa_failed",
      retryCount: 1,
      maxRetries: 3,
      lastQAResult: {
        verdict: "FAIL",
        summary: "Two tests failed",
        score: 42,
        timestamp: new Date().toISOString(),
        findings: [{ severity: "major", category: "test", message: "Unit test failure" }],
      },
    });
    render(<QALoopStatus taskId="TASK-1" />);

    expect(await screen.findByText("Two tests failed")).toBeInTheDocument();
    expect(screen.getByText("Findings (1)")).toBeInTheDocument();
    expect(screen.getByText("Unit test failure")).toBeInTheDocument();
    expect(screen.getByText("42/100")).toBeInTheDocument();
  });

  it("renders a no-data message when qaState is null", async () => {
    mockQA(null);
    render(<QALoopStatus taskId="TASK-1" />);
    expect(await screen.findByText("No QA loop data available")).toBeInTheDocument();
  });
});
