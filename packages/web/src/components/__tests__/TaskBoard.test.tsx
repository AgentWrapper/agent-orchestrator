import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskBoard from "../TaskBoard";

interface MockTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  role: string;
  projectId: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

function makeTask(overrides: Partial<MockTask>): MockTask {
  return {
    id: "TASK-1",
    title: "Sample task",
    description: "A description",
    status: "created",
    priority: "medium",
    role: "builder",
    projectId: "agentmesh",
    branch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function mockGet(tasks: MockTask[]) {
  global.fetch = vi.fn((_url: RequestInfo | URL, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      return Promise.resolve({ ok: true, json: async () => ({ id: "TASK-NEW" }) } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({ tasks }) } as Response);
  }) as unknown as typeof fetch;
}

describe("TaskBoard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a loading skeleton on mount", () => {
    mockGet([]);
    const { container } = render(<TaskBoard />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it("renders an error state when the tasks endpoint returns 500", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "Failed to list tasks" }),
      } as Response),
    ) as unknown as typeof fetch;

    render(<TaskBoard />);

    expect(await screen.findByText("Failed to load tasks")).toBeInTheDocument();
    expect(screen.getByText("Failed to list tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders an empty state in every column when there are no tasks", async () => {
    mockGet([]);
    render(<TaskBoard />);

    await waitFor(() => {
      expect(screen.getAllByText("No tasks").length).toBe(7);
    });
  });

  it("renders task cards in the column matching their status", async () => {
    mockGet([
      makeTask({ id: "TASK-A", title: "Build feature", status: "building" }),
      makeTask({ id: "TASK-B", title: "Run QA", status: "qa_running" }),
    ]);
    const { container } = render(<TaskBoard />);

    await screen.findByText("Build feature");

    const buildingColumn = container.querySelector('[data-column-id="building"]') as HTMLElement;
    const qaColumn = container.querySelector('[data-column-id="qa_running"]') as HTMLElement;
    expect(within(buildingColumn).getByText("Build feature")).toBeInTheDocument();
    expect(within(qaColumn).getByText("Run QA")).toBeInTheDocument();
  });

  it("opens the create-task modal when the New Task button is clicked", async () => {
    mockGet([]);
    render(<TaskBoard />);

    await waitFor(() => expect(screen.getAllByText("No tasks").length).toBe(7));

    fireEvent.click(screen.getByRole("button", { name: "+ New Task" }));
    expect(screen.getByText("Create New Task")).toBeInTheDocument();
  });

  it("keeps the create button disabled until a title is entered", async () => {
    mockGet([]);
    render(<TaskBoard />);
    await waitFor(() => expect(screen.getAllByText("No tasks").length).toBe(7));

    fireEvent.click(screen.getByRole("button", { name: "+ New Task" }));
    const createButton = screen.getByRole("button", { name: "Create Task" });
    expect(createButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My new task" } });
    expect(createButton).toBeEnabled();
  });

  it("POSTs to /api/agentmesh/tasks with the entered payload", async () => {
    mockGet([]);
    render(<TaskBoard />);
    await waitFor(() => expect(screen.getAllByText("No tasks").length).toBe(7));

    fireEvent.click(screen.getByRole("button", { name: "+ New Task" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My new task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => {
      const postCall = vi
        .mocked(fetch)
        .mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall?.[0]).toBe("/api/agentmesh/tasks");
      const body = JSON.parse((postCall?.[1] as RequestInit).body as string);
      expect(body).toMatchObject({
        title: "My new task",
        role: "builder",
        priority: "medium",
        branch: "main",
        projectId: "agentmesh",
      });
    });
  });
});
