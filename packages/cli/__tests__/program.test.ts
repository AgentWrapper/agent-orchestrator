import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createProgram } from "../src/program.js";

describe("createProgram", () => {
  it("uses the CLI package version", () => {
    expect(createProgram().version()).toBe(packageJson.version);
  });

  it("registers the project command", () => {
    expect(createProgram().commands.some((command) => command.name() === "project")).toBe(true);
  });
});
