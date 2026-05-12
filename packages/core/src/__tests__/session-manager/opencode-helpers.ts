import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const isWin = process.platform === "win32";
export const PATH_SEP = isWin ? ";" : ":";

export function installMockOpencode(
  tmpDir: string,
  sessionListJson: string,
  deleteLogPath: string,
  listDelaySeconds = 0,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin");
  mkdirSync(binDir, { recursive: true });

  if (isWin) {
    const jsPath = join(binDir, "opencode.js");
    writeFileSync(
      jsPath,
      `const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "list") {
  ${listLogPath ? `fs.appendFileSync(${JSON.stringify(listLogPath)}, args.join(" ") + "\\n");` : ""}
  ${listDelaySeconds > 0 ? `const end = Date.now() + ${listDelaySeconds * 1000}; while (Date.now() < end) {}` : ""}
  process.stdout.write(${JSON.stringify(sessionListJson)} + "\\n");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  fs.appendFileSync(${JSON.stringify(deleteLogPath)}, args.join(" ") + "\\n");
  process.exit(0);
}
process.exit(1);
`,
      "utf-8",
    );
    const cmdPath = join(binDir, "opencode.cmd");
    writeFileSync(cmdPath, `@node "%~dp0opencode.js" %*\r\n`, "utf-8");
  } else {
    const scriptPath = join(binDir, "opencode");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "session" && "$2" == "list" ]]; then',
        listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
        listDelaySeconds > 0 ? `  sleep ${listDelaySeconds}` : "",
        `  printf '%s\n' '${sessionListJson.replace(/'/g, "'\\''")}'`,
        "  exit 0",
        "fi",
        'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
        `  printf '%s\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
  }
  return binDir;
}

export function installMockOpencodeSequence(
  tmpDir: string,
  sessionListJsons: string[],
  deleteLogPath: string,
  listLogPath?: string,
): string {
  const binDir = join(tmpDir, "mock-bin-sequence");
  mkdirSync(binDir, { recursive: true });
  const sequencePath = join(tmpDir, `opencode-sequence-${randomUUID()}.txt`);
  writeFileSync(sequencePath, "0\n", "utf-8");

  if (isWin) {
    const jsPath = join(binDir, "opencode.js");
    const jsonEntries = sessionListJsons.map((j) => JSON.stringify(j)).join(", ");
    const finalJson = JSON.stringify(sessionListJsons.at(-1) ?? "[]");
    writeFileSync(
      jsPath,
      `const fs = require("fs");
const args = process.argv.slice(2);
const sequencePath = ${JSON.stringify(sequencePath)};
if (args[0] === "session" && args[1] === "list") {
  ${listLogPath ? `fs.appendFileSync(${JSON.stringify(listLogPath)}, args.join(" ") + "\\n");` : ""}
  const idx = parseInt(fs.readFileSync(sequencePath, "utf-8").trim(), 10);
  fs.writeFileSync(sequencePath, String(idx + 1) + "\\n");
  const entries = [${jsonEntries}];
  const result = idx < entries.length ? entries[idx] : ${finalJson};
  process.stdout.write(result + "\\n");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  fs.appendFileSync(${JSON.stringify(deleteLogPath)}, args.join(" ") + "\\n");
  process.exit(0);
}
process.exit(1);
`,
      "utf-8",
    );
    const cmdPath = join(binDir, "opencode.cmd");
    writeFileSync(cmdPath, `@node "%~dp0opencode.js" %*\r\n`, "utf-8");
  } else {
    const scriptPath = join(binDir, "opencode");

    const cases = sessionListJsons
      .map((entry, index) => {
        const escaped = entry.replace(/'/g, "'\\''");
        return `if [[ "$idx" == "${index}" ]]; then printf '%s\\n' '${escaped}'; exit 0; fi`;
      })
      .join("\n");
    const final = sessionListJsons.at(-1)?.replace(/'/g, "'\\''") ?? "[]";

    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "session" && "$2" == "list" ]]; then',
        listLogPath ? `  printf '%s\n' "$*" >> '${listLogPath.replace(/'/g, "'\\''")}'` : "",
        `  seq_file='${sequencePath.replace(/'/g, "'\\''")}'`,
        '  idx=$(cat "$seq_file")',
        "  next=$((idx + 1))",
        '  printf "%s\n" "$next" > "$seq_file"',
        `  ${cases}`,
        `  printf '%s\\n' '${final}'`,
        "  exit 0",
        "fi",
        'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
        `  printf '%s\n' "$*" >> '${deleteLogPath.replace(/'/g, "'\\''")}'`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
  }
  return binDir;
}

export function installMockOpencodeWithNotFoundDelete(
  tmpDir: string,
  sessionListJson: string,
): string {
  const binDir = join(tmpDir, "mock-bin-not-found");
  mkdirSync(binDir, { recursive: true });

  if (isWin) {
    const jsPath = join(binDir, "opencode.js");
    writeFileSync(
      jsPath,
      `const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(sessionListJson)} + "\\n");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "delete") {
  process.stderr.write("Error: Session not found: " + args[2] + "\\n");
  process.exit(1);
}
process.exit(1);
`,
      "utf-8",
    );
    const cmdPath = join(binDir, "opencode.cmd");
    writeFileSync(cmdPath, `@node "%~dp0opencode.js" %*\r\n`, "utf-8");
  } else {
    const scriptPath = join(binDir, "opencode");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "session" && "$2" == "list" ]]; then',
        `  printf '%s\n' '${sessionListJson.replace(/'/g, "'\\''")}'`,
        "  exit 0",
        "fi",
        'if [[ "$1" == "session" && "$2" == "delete" ]]; then',
        '  printf "Error: Session not found: %s\\n" "$3" >&2',
        "  exit 1",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
  }
  return binDir;
}

export function installMockGit(
  tmpDir: string,
  remoteBranches: string[],
): string {
  const binDir = join(tmpDir, "mock-git-bin");
  mkdirSync(binDir, { recursive: true });

  if (isWin) {
    const refs = remoteBranches
      .map((branch) => `deadbeef\trefs/heads/${branch}`)
      .join("\n");
    const jsPath = join(binDir, "git.js");
    writeFileSync(
      jsPath,
      `const args = process.argv.slice(2);
if (args[0] === "ls-remote" && args[1] === "--heads" && args[2] === "origin") {
  process.stdout.write(${JSON.stringify(refs)} + "\\n");
  process.exit(0);
}
process.exit(1);
`,
      "utf-8",
    );
    const cmdPath = join(binDir, "git.cmd");
    writeFileSync(cmdPath, `@node "%~dp0git.js" %*\r\n`, "utf-8");
  } else {
    const scriptPath = join(binDir, "git");
    const refs = remoteBranches
      .map((branch) => `deadbeef\trefs/heads/${branch}`)
      .join("\\n")
      .replace(/'/g, "'\\''");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "ls-remote" && "$2" == "--heads" && "$3" == "origin" ]]; then',
        `  printf '%b\\n' '${refs}'`,
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(scriptPath, 0o755);
  }
  return binDir;
}
