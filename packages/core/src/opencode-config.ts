import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function getOpenCodeConfigPath(baseDir: string, sessionId: string): string {
  return join(baseDir, `opencode-config-${sessionId}.json`);
}

export function writeOpenCodeConfig(
  baseDir: string,
  sessionId: string,
  instructionFiles: string[],
): string {
  mkdirSync(baseDir, { recursive: true });
  const configPath = getOpenCodeConfigPath(baseDir, sessionId);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        instructions: instructionFiles,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return configPath;
}
