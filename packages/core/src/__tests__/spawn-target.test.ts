import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "../spawn-target.js";
import type { ProjectConfig } from "../types.js";

const baseProject: Omit<ProjectConfig, "name" | "path" | "sessionPrefix"> = {
  defaultBranch: "main",
};

function makeProjects(): Record<string, ProjectConfig> {
  return {
    "agent-orchestrator": {
      ...baseProject,
      name: "Agent Orchestrator",
      path: "/tmp/ao",
      sessionPrefix: "ao",
    },
    "x402-identity": {
      ...baseProject,
      name: "x402 Identity",
      path: "/tmp/xid",
      sessionPrefix: "xid",
    },
  };
}

describe("resolveSpawnTarget", () => {
  it("routes to the project matched by id prefix", () => {
    const target = resolveSpawnTarget(makeProjects(), "x402-identity/1");
    expect(target).toEqual({ projectId: "x402-identity", issueId: "1" });
  });

  it("routes to the project matched by sessionPrefix", () => {
    const target = resolveSpawnTarget(makeProjects(), "xid/42");
    expect(target).toEqual({ projectId: "x402-identity", issueId: "42" });
  });

  it("prefers project-id match over sessionPrefix collision", () => {
    const projects = makeProjects();
    // Give the other project a sessionPrefix that collides with the first project's id
    projects["x402-identity"].sessionPrefix = "agent-orchestrator";
    const target = resolveSpawnTarget(projects, "agent-orchestrator/9");
    expect(target).toEqual({ projectId: "agent-orchestrator", issueId: "9" });
  });

  it("falls back to the fallback project when the prefix doesn't match", () => {
    const target = resolveSpawnTarget(makeProjects(), "some-org/42", "agent-orchestrator");
    expect(target).toEqual({ projectId: "agent-orchestrator", issueId: "some-org/42" });
  });

  it("returns null without a fallback when nothing matches", () => {
    expect(resolveSpawnTarget(makeProjects(), "some-org/42")).toBeNull();
  });

  it("treats a bare issue id as plain identifier", () => {
    const target = resolveSpawnTarget(makeProjects(), "INT-100", "x402-identity");
    expect(target).toEqual({ projectId: "x402-identity", issueId: "INT-100" });
  });

  it("does not match inherited prototype keys", () => {
    // Regular plain objects inherit `__proto__`, `constructor`, `toString`, etc.
    // from Object.prototype — a truthy `projects[prefix]` check without hasOwn
    // would mis-route these.
    const projects = makeProjects();
    expect(resolveSpawnTarget(projects, "__proto__/42", "agent-orchestrator")).toEqual({
      projectId: "agent-orchestrator",
      issueId: "__proto__/42",
    });
    expect(resolveSpawnTarget(projects, "constructor/42", "agent-orchestrator")).toEqual({
      projectId: "agent-orchestrator",
      issueId: "constructor/42",
    });
    expect(resolveSpawnTarget(projects, "toString/42", "agent-orchestrator")).toEqual({
      projectId: "agent-orchestrator",
      issueId: "toString/42",
    });
  });

  it("ignores leading-slash and trailing-slash inputs", () => {
    expect(resolveSpawnTarget(makeProjects(), "/42", "agent-orchestrator")).toEqual({
      projectId: "agent-orchestrator",
      issueId: "/42",
    });
    expect(resolveSpawnTarget(makeProjects(), "x402-identity/", "agent-orchestrator")).toEqual({
      projectId: "agent-orchestrator",
      issueId: "x402-identity/",
    });
  });

});
