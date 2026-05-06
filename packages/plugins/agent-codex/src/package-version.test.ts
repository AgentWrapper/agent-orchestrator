import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("package manifest version", () => {
  it("is bumped to 0.5.0", () => {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: string };

    expect(packageJson.version).toBe("0.5.0");
  });
});
