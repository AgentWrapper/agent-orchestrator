import { afterEach, expect, it, vi } from "vitest";

import type { CloudAPI, CloudWorkspaceDiff } from "./cloud-api";
import {
  getWorkspaceSnapshot,
  removeWorkspaceSnapshots,
  subscribeWorkspaceSnapshot,
  warmWorkspaceSession,
} from "./cloud-workspace-cache";

afterEach(() => removeWorkspaceSnapshots(new Set()));

it("single-flights workspace polling per session", async () => {
  let resolveDiff!: (value: CloudWorkspaceDiff) => void;
  let resolveFiles!: (value: { path: string; entries: [] }) => void;
  const api = {
    workspaceDiff: vi.fn(
      () =>
        new Promise<CloudWorkspaceDiff>((resolve) => {
          resolveDiff = resolve;
        }),
    ),
    workspaceFiles: vi.fn(
      () =>
        new Promise<{ path: string; entries: [] }>((resolve) => {
          resolveFiles = resolve;
        }),
    ),
  } as unknown as CloudAPI;

  const first = warmWorkspaceSession(api, "org-one", "session-one");
  const second = warmWorkspaceSession(api, "org-one", "session-one");

  expect(second).toBe(first);
  expect(api.workspaceDiff).toHaveBeenCalledTimes(1);
  expect(api.workspaceFiles).toHaveBeenCalledTimes(1);

  resolveDiff({ status: "", staged: "", unstaged: "" });
  resolveFiles({ path: ".", entries: [] });
  await first;

  expect(getWorkspaceSnapshot("session-one")?.diff).toEqual({
    status: "",
    staged: "",
    unstaged: "",
  });
});

it("publishes partial refreshes without discarding cached data", async () => {
  const initialDiff = { status: "?? index.html", staged: "", unstaged: "" };
  const initialAPI = {
    workspaceDiff: vi.fn().mockResolvedValue(initialDiff),
    workspaceFiles: vi.fn().mockResolvedValue({ path: ".", entries: [] }),
  } as unknown as CloudAPI;
  await warmWorkspaceSession(initialAPI, "org-one", "session-one");

  const listener = vi.fn();
  const unsubscribe = subscribeWorkspaceSnapshot("session-one", listener);
  const refreshAPI = {
    workspaceDiff: vi.fn().mockRejectedValue(new Error("diff unavailable")),
    workspaceFiles: vi.fn().mockResolvedValue({
      path: ".",
      entries: [
        {
          name: "README.md",
          path: "README.md",
          isDir: false,
          size: 10,
          mode: "-rw-r--r--",
          modTime: "2026-08-01T00:00:00Z",
        },
      ],
    }),
  } as unknown as CloudAPI;

  await warmWorkspaceSession(refreshAPI, "org-one", "session-one");

  const snapshot = getWorkspaceSnapshot("session-one");
  expect(snapshot?.diff).toEqual(initialDiff);
  expect(snapshot?.diffError).toBe("diff unavailable");
  expect(snapshot?.rootEntries?.[0]?.path).toBe("README.md");
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});
