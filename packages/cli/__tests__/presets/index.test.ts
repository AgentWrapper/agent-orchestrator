import { describe, it, expect } from "vitest";
import { resolvePreset } from "../../src/presets/index.js";
import { backlogPreset } from "../../src/presets/backlog.js";

describe("resolvePreset", () => {
  it("returns the backlog preset by name", () => {
    const preset = resolvePreset("backlog");
    expect(preset).toBe(backlogPreset);
    expect(preset.name).toBe("backlog");
  });

  it("throws for unknown preset names", () => {
    expect(() => resolvePreset("nonexistent")).toThrow("Unknown preset");
  });

  it("includes available presets in the error message", () => {
    expect(() => resolvePreset("nope")).toThrow("backlog");
  });
});

describe("backlog preset", () => {
  it("has required fields", () => {
    expect(backlogPreset.name).toBe("backlog");
    expect(backlogPreset.description).toBeTruthy();
    expect(backlogPreset.prompt).toBeTruthy();
  });

  it("prompt contains key instructions", () => {
    const { prompt } = backlogPreset;
    // Gathers session data
    expect(prompt).toContain("ao status --reports full --json --include-terminated");
    // Gathers GitHub data
    expect(prompt).toContain("gh issue list");
    expect(prompt).toContain("gh pr list");
    // Saves markdown report
    expect(prompt).toContain("backlog/report_");
    // Instructs orchestrator
    expect(prompt).toContain("ao send");
    // Generates HTML
    expect(prompt).toContain("dashboard_");
    // Reports completion
    expect(prompt).toContain("ao report completed");
  });

  it("prompt is multi-line markdown with preserved newlines", () => {
    expect(backlogPreset.prompt).toContain("\n");
    expect(backlogPreset.prompt.split("\n").length).toBeGreaterThan(10);
  });
});
