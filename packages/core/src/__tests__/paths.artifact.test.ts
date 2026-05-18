import { describe, it, expect } from "vitest";
import {
  getProjectArtifactsDir,
  getSessionArtifactsDir,
  getSessionArtifactsStagingDir,
} from "../paths.js";
import { homedir } from "node:os";
import { join } from "node:path";

describe("artifact path helpers", () => {
  it("getProjectArtifactsDir returns the project artifacts dir", () => {
    expect(getProjectArtifactsDir("agent-orchestrator_abc123")).toBe(
      join(homedir(), ".agent-orchestrator", "projects", "agent-orchestrator_abc123", "artifacts"),
    );
  });

  it("getSessionArtifactsDir returns the session artifacts dir", () => {
    expect(getSessionArtifactsDir("agent-orchestrator_abc123", "ao-139")).toBe(
      join(homedir(), ".agent-orchestrator", "projects", "agent-orchestrator_abc123", "artifacts", "ao-139"),
    );
  });

  it("getSessionArtifactsStagingDir returns the staging dir", () => {
    expect(getSessionArtifactsStagingDir("agent-orchestrator_abc123", "ao-139")).toBe(
      join(homedir(), ".agent-orchestrator", "projects", "agent-orchestrator_abc123", "artifacts", "ao-139", ".staging"),
    );
  });

  it("rejects unsafe session ids", () => {
    expect(() => getSessionArtifactsDir("p", "../etc")).toThrow(/unsafe session/i);
    expect(() => getSessionArtifactsDir("p", "foo/bar")).toThrow(/unsafe session/i);
    expect(() => getSessionArtifactsDir("p", "")).toThrow(/unsafe session/i);
  });

  it("rejects unsafe project ids", () => {
    expect(() => getProjectArtifactsDir("../etc")).toThrow(/unsafe project/i);
  });
});
