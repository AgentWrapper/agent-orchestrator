import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _args: string[],
      _options: { timeout: number },
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => callback(null, "", ""),
  ),
);

const getServicesMock = vi.hoisted(() =>
  vi.fn(async () => ({
    config: {
      projects: {
        app: { repo: "acme/app" },
      },
    },
  })),
);

vi.mock("node:child_process", () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

vi.mock("@/lib/services", () => ({
  getServices: getServicesMock,
}));

import { POST } from "./route";

describe("POST /api/setup-labels", () => {
  beforeEach(() => {
    execFileMock.mockClear();
    getServicesMock.mockClear();
  });

  it("creates verification lifecycle labels", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    for (const [name, color, description] of [
      ["merged-unverified", "F59E0B", "PR merged; awaiting verification"],
      ["verified", "16A34A", "Work verified after staging check"],
      ["verification-failed", "DC2626", "Verification failed; needs follow-up"],
    ]) {
      expect(execFileMock).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining([
          "label",
          "create",
          name,
          "--repo",
          "acme/app",
          "--color",
          color,
          "--description",
          description,
          "--force",
        ]),
        { timeout: 10_000 },
        expect.any(Function),
      );
    }
  });
});
