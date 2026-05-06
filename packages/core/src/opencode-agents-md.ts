import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AO_OPENCODE_SECTION_START = "<!-- AO_ORCHESTRATOR_PROMPT_START -->";
const AO_OPENCODE_SECTION_END = "<!-- AO_ORCHESTRATOR_PROMPT_END -->";

export function getWorkspaceAgentsMdPath(workspacePath: string): string {
  return join(workspacePath, "AGENTS.md");
}

function stripExistingAoOpenCodeSection(content: string): string {
  const start = content.indexOf(AO_OPENCODE_SECTION_START);
  const end = content.indexOf(AO_OPENCODE_SECTION_END);
  if (start === -1 || end === -1 || end < start) {
    return content;
  }

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + AO_OPENCODE_SECTION_END.length).trimStart();

  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

export function writeWorkspaceOpenCodeAgentsMd(workspacePath: string, promptFile: string): string {
  const agentsMdPath = getWorkspaceAgentsMdPath(workspacePath);
  mkdirSync(workspacePath, { recursive: true });

  const existing = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf-8") : "";
  const baseContent = stripExistingAoOpenCodeSection(existing).trimEnd();
  const prompt = readFileSync(promptFile, "utf-8").trim();
  const aoSection = [
    AO_OPENCODE_SECTION_START,
    "## Agent Orchestrator",
    "",
    prompt,
    AO_OPENCODE_SECTION_END,
  ].join("\n");

  const nextContent = baseContent ? `${baseContent}\n\n${aoSection}\n` : `${aoSection}\n`;
  writeFileSync(agentsMdPath, nextContent, "utf-8");
  return agentsMdPath;
}
