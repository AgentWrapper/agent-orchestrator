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
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toEqual(
      expect.arrayContaining([
        { repo: "acme/app", label: "merged-unverified", status: "created" },
        { repo: "acme/app", label: "verified", status: "created" },
        { repo: "acme/app", label: "verification-failed", status: "created" },
      ]),
    );
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

  it("records label creation failures as existing labels", async () => {
    execFileMock.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _options: { timeout: number },
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => callback(new Error("label already exists"), "", ""),
    );

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0]).toEqual({
      repo: "acme/app",
      label: "agent:backlog",
      status: "exists",
    });
    expect(body.results).toEqual(
      expect.arrayContaining([
        { repo: "acme/app", label: "merged-unverified", status: "created" },
      ]),
    );
  });
});
