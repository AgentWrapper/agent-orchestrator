import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { getCliVersion } from "../../src/options/version.js";

describe("getCliVersion", () => {
  it("matches the CLI package version", () => {
    expect(getCliVersion()).toBe(packageJson.version);
  });
});
