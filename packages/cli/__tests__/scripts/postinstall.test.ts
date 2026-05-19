import { describe, expect, it } from "vitest";

import {
  betterSqlite3BindingCandidates,
  betterSqlite3RebuildCommand,
  hasBetterSqlite3Binding,
} from "../../../ao/bin/postinstall.js";

describe("ao postinstall better-sqlite3 native binding detection", () => {
  const env = {
    platform: "darwin",
    arch: "arm64",
    modules: "141",
    nodeVersion: "25.9.0",
  };

  it("checks the current Node ABI binding path", () => {
    const packageDir = "virtual-better-sqlite3";
    const candidates = betterSqlite3BindingCandidates(packageDir, env);

    expect(candidates.some((candidate) => candidate.includes("node-v141-darwin-arm64"))).toBe(true);
  });

  it("reports the binding present when a mocked candidate exists", () => {
    const packageDir = "virtual-better-sqlite3";
    const candidates = betterSqlite3BindingCandidates(packageDir, env);
    const currentAbiBinding = candidates.find((candidate) =>
      candidate.includes("node-v141-darwin-arm64"),
    );
    if (!currentAbiBinding) {
      throw new Error("expected current ABI binding candidate");
    }

    const existingFiles = new Set([currentAbiBinding]);

    expect(
      hasBetterSqlite3Binding(packageDir, {
        ...env,
        existsSync: (candidate: string) => existingFiles.has(candidate),
      }),
    ).toBe(true);
  });

  it("reports the binding missing when no mocked candidate exists", () => {
    expect(
      hasBetterSqlite3Binding("virtual-better-sqlite3", {
        ...env,
        existsSync: () => false,
      }),
    ).toBe(false);
  });

  it("uses pnpm to rebuild inside the resolved better-sqlite3 package", () => {
    expect(
      betterSqlite3RebuildCommand("virtual-better-sqlite3", {
        npm_config_user_agent: "pnpm/9.15.4 npm/? node/v25.9.0 darwin arm64",
      }),
    ).toEqual({
      command: "pnpm",
      args: ["--dir", "virtual-better-sqlite3", "rebuild"],
      display: "pnpm --dir virtual-better-sqlite3 rebuild",
    });
  });
});
