import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { CloudAPI } from "@/lib/cloud-api";
import { CloudInspector, type CloudInspectorTab } from "./CloudInspector";

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
  } as unknown as CloudAPI;
}

function InspectorHarness({ api }: { api: CloudAPI }) {
  const [tab, setTab] = useState<CloudInspectorTab>("changes");
  return (
    <CloudInspector
      api={api}
      sessionId="session-one"
      runtimeConnected
      tab={tab}
      width={480}
      onTabChange={setTab}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

it("switches between changes, files, and a capability-scoped browser preview", async () => {
  const user = userEvent.setup();
  const api = inspectorAPI();
  render(<InspectorHarness api={api} />);

  expect(await screen.findByText("Working tree is clean")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Files" }));
  const readme = await screen.findByRole("button", { name: /README\.md/ });
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
});

it("keeps workspace tools unavailable until the worker connects", () => {
  render(
    <CloudInspector
      api={inspectorAPI()}
      sessionId="session-one"
      runtimeConnected={false}
      tab="terminal"
      width={480}
      onTabChange={vi.fn()}
      onWidthChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByText("Preparing workspace tools")).toBeInTheDocument();
});
