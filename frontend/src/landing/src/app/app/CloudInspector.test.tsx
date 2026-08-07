import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { CloudAPI } from "@/lib/cloud-api";
import { removeWorkspaceSnapshots } from "@/lib/cloud-workspace-cache";
import { CloudInspector, type CloudInspectorTab } from "./CloudInspector";

vi.mock("./CloudTerminal", () => ({
  CloudTerminal: () => <div>Persistent terminal</div>,
}));

afterEach(() => removeWorkspaceSnapshots(new Set()));

function inspectorAPI() {
  return {
    workspaceDiff: vi.fn().mockResolvedValue({
      status: "",
      staged: "",
      unstaged: "",
    }),
    workspaceFiles: vi.fn().mockResolvedValue({
      path: "",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          isDir: false,
          size: 42,
          mode: "-rw-r--r--",
          modTime: "2026-07-30T00:00:00Z",
        },
      ],
    }),
    workspaceFile: vi.fn().mockResolvedValue({
      path: "README.md",
      content: "# AO",
      size: 4,
    }),
    workspacePreviewTicket: vi.fn().mockResolvedValue({
      url: "https://cloud.example/api/cloud/v1/preview/token/",
      expiresAt: "2026-07-30T01:00:00Z",
    }),
    workspaceFilePreviewTicket: vi.fn().mockResolvedValue({
      url: "https://cloud.example/api/cloud/v1/preview/file-token/",
      expiresAt: "2026-07-30T01:00:00Z",
    }),
    sessionEnvironment: vi.fn().mockResolvedValue({
      revision: 2,
      names: ["API_TOKEN"],
    }),
    updateSessionEnvironment: vi.fn().mockResolvedValue({
      revision: 3,
      names: ["API_TOKEN", "DATABASE_URL"],
      willRestart: true,
    }),
  } as unknown as CloudAPI;
}

function InspectorHarness({
  api,
  canManageEnvironment = false,
}: {
  api: CloudAPI;
  canManageEnvironment?: boolean;
}) {
  const [tab, setTab] = useState<CloudInspectorTab>("changes");
  return (
    <CloudInspector
      api={api}
      orgId="org-one"
      sessionId="session-one"
      runtimeConnected
      canManageEnvironment={canManageEnvironment}
      tab={tab}
      open
      width={480}
      onTabChange={setTab}
      onPreviewAddressChange={vi.fn()}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

it("manages write-only environment values and reports the in-place restart", async () => {
  const user = userEvent.setup();
  const api = inspectorAPI();
  render(<InspectorHarness api={api} canManageEnvironment />);

  await user.click(screen.getByRole("button", { name: "Environment" }));
  expect(await screen.findByText("API_TOKEN")).toBeInTheDocument();
  expect(screen.getByText("••••••••")).toBeInTheDocument();

  await user.type(screen.getByRole("textbox", { name: "Variable name" }), "DATABASE_URL");
  await user.type(screen.getByLabelText("Variable value"), "postgres://secret");
  await user.click(screen.getByRole("button", { name: "Add environment variable" }));

  expect(screen.queryByText("postgres://secret")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.updateSessionEnvironment).toHaveBeenCalledWith(
      "org-one",
      "session-one",
      {
        expectedRevision: 2,
        upserts: [{ name: "DATABASE_URL", value: "postgres://secret" }],
        removals: [],
      },
    ),
  );
  expect(
    await screen.findByText(/Terminal is restarting.*existing agent session will resume/),
  ).toBeInTheDocument();
});

it("does not expose the environment tab without management permission", () => {
  render(<InspectorHarness api={inspectorAPI()} />);
  expect(
    screen.queryByRole("button", { name: "Environment" }),
  ).not.toBeInTheDocument();
});

it("switches between changes, files, and a capability-scoped browser preview", async () => {
  const user = userEvent.setup();
  const api = inspectorAPI();
  render(<InspectorHarness api={api} />);

  expect(await screen.findByText("Working tree is clean")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Files" }));
  const readme = await screen.findByRole("button", { name: /README\.md/ });
  expect(screen.queryByText("Working tree is clean")).not.toBeInTheDocument();
  await user.click(readme);
  expect(await screen.findByText("# AO")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Browser" }));
  const address = screen.getByRole("textbox", { name: "Preview address" });
  await user.clear(address);
  await user.type(address, "localhost:4173/docs");
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(screen.getByTitle("Worker preview")).toHaveAttribute(
      "src",
      "https://cloud.example/api/cloud/v1/preview/token/docs",
    ),
  );

  await user.clear(address);
  await user.type(address, "http://localhost:5002/dashboard");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(api.workspacePreviewTicket).toHaveBeenLastCalledWith(
      "org-one",
      "session-one",
      5002,
    ),
  );
  expect(screen.getByTitle("Worker preview")).toHaveAttribute(
    "src",
    "https://cloud.example/api/cloud/v1/preview/token/dashboard",
  );

  await user.clear(address);
  await user.type(address, "file:///workspace/repository/examples/index.html");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByTitle("Worker preview")).toHaveAttribute(
      "src",
      "https://cloud.example/api/cloud/v1/preview/file-token/",
    ),
  );
  expect(api.workspaceFilePreviewTicket).toHaveBeenCalledWith(
    "org-one",
    "session-one",
    "examples/index.html",
  );
});

it("keeps workspace tools unavailable until the worker connects", () => {
  render(
    <CloudInspector
      api={inspectorAPI()}
      orgId="org-one"
      sessionId="session-one"
      runtimeConnected={false}
      tab="terminal"
      open
      width={480}
      onTabChange={vi.fn()}
      onPreviewAddressChange={vi.fn()}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByText("VM is loading…")).toBeInTheDocument();
  expect(
    screen.queryByText(/Terminal, files, changes/),
  ).not.toBeInTheDocument();
});

it("does not mount or fetch inspector panes while closed", () => {
  const api = inspectorAPI();
  render(
    <CloudInspector
      api={api}
      orgId="org-one"
      sessionId="session-one"
      runtimeConnected
      tab="changes"
      open={false}
      width={480}
      onTabChange={vi.fn()}
      onPreviewAddressChange={vi.fn()}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(api.workspaceDiff).not.toHaveBeenCalled();
  expect(api.workspaceFiles).not.toHaveBeenCalled();
  expect(screen.queryByText("Working tree is clean")).not.toBeInTheDocument();
});

it("loads a nested untracked file diff only when the file is selected", async () => {
  const user = userEvent.setup();
  const api = inspectorAPI();
  vi.mocked(api.workspaceDiff).mockResolvedValue({
    status: "?? examples/dummy/index.html\n",
    staged: "",
    unstaged: "",
  });
  vi.mocked(api.workspaceFile).mockResolvedValue({
    path: "examples/dummy/index.html",
    content: "<main>\n  AO Cloud\n</main>\n",
    size: 27,
  });

  render(<InspectorHarness api={api} />);

  const untracked = await screen.findByRole("button", {
    name: /index\.html, 0 additions, 0 deletions/,
  });
  expect(api.workspaceFile).not.toHaveBeenCalled();

  await user.click(untracked);

  expect(
    await screen.findByRole("button", {
      name: /index\.html, 3 additions, 0 deletions/,
    }),
  ).toBeVisible();
  expect(api.workspaceFile).toHaveBeenCalledWith(
    "org-one",
    "session-one",
    "examples/dummy/index.html",
  );
  expect(screen.getAllByText("+3").length).toBeGreaterThan(0);
  expect(screen.getByText("AO Cloud")).toBeVisible();
  expect(screen.getByText("Untracked")).toBeVisible();
});
