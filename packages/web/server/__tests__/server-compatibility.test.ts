/**
 * Server compatibility tests.
 *
 * These verify that the terminal server files import shared utilities
 * from tmux-utils.ts and don't contain deprecated patterns from the
 * pre-hash-based architecture (config.dataDir, loadConfig, existsSync).
 *
 * For actual behavioral tests of the shared utilities, see tmux-utils.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverDir = join(__dirname, "..");

function readServerFile(name: string): string {
  return readFileSync(join(serverDir, name), "utf-8");
}

describe("direct-terminal-ws.ts", () => {
  const source = readServerFile("direct-terminal-ws.ts");

  it("imports from shared tmux-utils", () => {
    expect(source).toMatch(/from\s+["']\.\/tmux-utils/);
  });

  it("does not import loadConfig from @aoagents/ao-core", () => {
    expect(source).not.toMatch(/import\s.*loadConfig.*from\s+["']@aoagents\/ao-core["']/);
  });

  it("does not reference config.dataDir", () => {
    expect(source).not.toMatch(/config\.dataDir/);
  });

  it("does not use bare 'tmux' string for ptySpawn", () => {
    expect(source).not.toMatch(/ptySpawn\(\s*["']tmux["']/);
  });

  it("does not check file existence for session validation", () => {
    expect(source).not.toMatch(/existsSync.*session/i);
  });

  it("exposes terminal health metrics in /health response", () => {
    expect(source).toMatch(/metrics/);
    expect(source).toMatch(/totalConnections/);
    expect(source).toMatch(/totalDisconnects/);
    expect(source).toMatch(/totalErrors/);
  });
});


describe("OrchestratorConfig compatibility", () => {
  it("OrchestratorConfig does not have dataDir property", () => {
    const typesSource = readFileSync(
      join(__dirname, "..", "..", "..", "core", "src", "types.ts"),
      "utf-8",
    );

    const configMatch = typesSource.match(/export interface OrchestratorConfig \{[\s\S]*?\n\}/);
    expect(configMatch).toBeTruthy();
    const configBlock = configMatch![0];

    expect(configBlock).not.toMatch(/dataDir/);
    expect(configBlock).toMatch(/configPath/);
  });
});
