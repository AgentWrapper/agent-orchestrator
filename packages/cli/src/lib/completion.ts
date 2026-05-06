import type { Argument, Command, Option } from "commander";
import {
  AGENT_REPORTED_STATES,
  isTerminalSession,
  loadConfig,
  loadGlobalConfig,
  getGlobalConfigPath,
  type OrchestratorConfig,
  type Session,
} from "@aoagents/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import { isOrchestratorSessionName } from "./session-utils.js";

export interface CompletionSuggestion {
  value: string;
  description?: string;
}

export interface CompletionDataOptions {
  includeOrchestrators?: boolean;
  includeTerminated?: boolean;
}

interface CompletionCommandNode {
  functionName: string;
  path: string[];
  description: string;
  options: readonly Option[];
  arguments: readonly Argument[];
  children: CompletionCommandNode[];
}

const REPORT_STATE_SUGGESTIONS: readonly CompletionSuggestion[] = [
  { value: "started", description: "Session picked up" },
  { value: "working", description: "Actively making progress" },
  { value: "waiting", description: "Waiting on an external dependency" },
  { value: "needs-input", description: "Needs human input" },
  { value: "fixing-ci", description: "Working on CI failures" },
  { value: "addressing-reviews", description: "Working on review feedback" },
  { value: "pr-created", description: "Created a PR" },
  { value: "draft-pr-created", description: "Created a draft PR" },
  { value: "ready-for-review", description: "PR is ready for review" },
  { value: "completed", description: "Finished non-PR work" },
] as const;

// Keep in sync with core plugin slot names.
const PLUGIN_SLOT_SUGGESTIONS: readonly CompletionSuggestion[] = [
  { value: "runtime", description: "Execution runtime plugins" },
  { value: "agent", description: "Worker/orchestrator agent plugins" },
  { value: "workspace", description: "Workspace isolation plugins" },
  { value: "tracker", description: "Issue tracker plugins" },
  { value: "scm", description: "Source control plugins" },
  { value: "notifier", description: "Notification plugins" },
  { value: "terminal", description: "Terminal attachment plugins" },
] as const;

const HIDDEN_COMMAND_NAMES = new Set<string>(["__complete"]);

function isHiddenCommand(command: Command): boolean {
  const commandName = command.name();
  return commandName.startsWith("__") || HIDDEN_COMMAND_NAMES.has(commandName);
}

function buildCommandTree(command: Command, path: string[]): CompletionCommandNode {
  const children = command.commands
    .filter((child) => !isHiddenCommand(child))
    .map((child) => buildCommandTree(child, [...path, child.name()]));

  return {
    functionName: path.length === 0 ? "_ao" : `_ao_${path.join("_").replace(/[^a-zA-Z0-9_]/g, "_")}`,
    path,
    description: command.description() || "",
    options: command.options.filter((option) => !option.hidden),
    arguments: command.registeredArguments,
    children,
  };
}

function normalizeText(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function quoteForZsh(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "'\\''")}'`;
}

function escapeDescribeText(text: string): string {
  return normalizeText(text).replace(/:/g, "\\:");
}

function escapeSpecDescription(text: string): string {
  return normalizeText(text).replace(/]/g, "\\]");
}

function describeEntries(items: readonly CompletionSuggestion[]): string[] {
  return items.map((item) =>
    quoteForZsh(`${escapeDescribeText(item.value)}:${escapeDescribeText(item.description ?? "")}`),
  );
}

function commandKey(node: CompletionCommandNode): string {
  return node.path.join(" ");
}

function optionMatches(option: Option, flag: string): boolean {
  return option.short === flag || option.long === flag;
}

function getArgumentAction(node: CompletionCommandNode, argumentIndex: number): string | undefined {
  const key = commandKey(node);

  if (key === "start" && argumentIndex === 0) return "_ao_complete_start_target";
  if (key === "stop" && argumentIndex === 0) return "_ao_complete_projects";
  if (key === "send" && argumentIndex === 0) return "_ao_complete_sessions";
  if (key === "open" && argumentIndex === 0) return "_ao_complete_open_targets";
  if (key === "report" && argumentIndex === 0) return "_ao_complete_report_states";
  if (key === "session attach" && argumentIndex === 0) return "_ao_complete_sessions";
  if (key === "session kill" && argumentIndex === 0) return "_ao_complete_sessions";
  if (key === "session restore" && argumentIndex === 0) return "_ao_complete_all_sessions";
  if (key === "session remap" && argumentIndex === 0) return "_ao_complete_all_sessions";
  if (key === "session claim-pr" && argumentIndex === 1) return "_ao_complete_sessions";

  const argumentName =
    argumentIndex >= 0 ? node.arguments[argumentIndex]?.name()?.toLowerCase() ?? "" : "";
  if (
    argumentName.includes("path") ||
    argumentName.includes("file") ||
    argumentName.includes("directory")
  ) {
    return "_files";
  }

  return undefined;
}

function getOptionAction(node: CompletionCommandNode, option: Option): string | undefined {
  const key = commandKey(node);

  if (key === "status" && (optionMatches(option, "-p") || optionMatches(option, "--project"))) {
    return "_ao_complete_projects";
  }
  if (key === "verify" && (optionMatches(option, "-p") || optionMatches(option, "--project"))) {
    return "_ao_complete_projects";
  }
  if (
    key === "session ls" &&
    (optionMatches(option, "-p") || optionMatches(option, "--project"))
  ) {
    return "_ao_complete_projects";
  }
  if (
    key === "session cleanup" &&
    (optionMatches(option, "-p") || optionMatches(option, "--project"))
  ) {
    return "_ao_complete_projects";
  }
  if (key === "plugin list" && optionMatches(option, "--type")) {
    return "_ao_complete_plugin_slots";
  }
  if (key === "plugin create" && optionMatches(option, "--slot")) {
    return "_ao_complete_plugin_slots";
  }

  const attributeName = option.attributeName().toLowerCase();
  if (
    attributeName.includes("file") ||
    attributeName.includes("path") ||
    attributeName.includes("directory")
  ) {
    return "_files";
  }

  return undefined;
}

function getValueLabel(option: Option): string {
  if (option.long) return option.long.replace(/^--/, "");
  if (option.short) return option.short.replace(/^-/, "");
  return option.attributeName();
}

function renderOptionSpecs(node: CompletionCommandNode): string[] {
  const specs: string[] = [];

  for (const option of node.options) {
    const description = escapeSpecDescription(option.description || option.flags);
    const action = getOptionAction(node, option);
    const valueLabel = option.required || option.optional ? getValueLabel(option) : undefined;

    for (const flag of [option.short, option.long].filter((entry): entry is string => Boolean(entry))) {
      const base = `${flag}[${description}]`;
      const spec =
        valueLabel !== undefined ? `${base}:${valueLabel}:${action ?? ""}` : base;
      specs.push(spec);
    }
  }

  return specs;
}

function renderArgumentSpecs(node: CompletionCommandNode): string[] {
  return node.arguments.map((argument, index) => {
    const action = getArgumentAction(node, index);
    const label = argument.name();
    const position = argument.variadic ? "*" : String(index + 1);
    const optional = argument.required ? ":" : "::";
    return `${position}${optional}${label}:${action ?? ""}`;
  });
}

function renderArgumentsInvocation(node: CompletionCommandNode): string[] {
  const specs = [...renderOptionSpecs(node)];

  if (node.children.length > 0) {
    specs.push("1:command:->subcommand");
  } else {
    specs.push(...renderArgumentSpecs(node));
  }

  if (specs.length === 0) {
    return ["  return 1"];
  }

  const lines = ["  _arguments -C \\"];
  for (let index = 0; index < specs.length; index += 1) {
    const suffix = index === specs.length - 1 ? "" : " \\";
    lines.push(`    ${quoteForZsh(specs[index])}${suffix}`);
  }
  return lines;
}

function renderSubcommandCase(node: CompletionCommandNode): string[] {
  if (node.children.length === 0) return [];

  const describeLabel = node.path.length === 0 ? "ao command" : `${commandKey(node)} command`;
  const lines = [
    "  case $state in",
    "    subcommand)",
    "      local -a subcommands",
    "      subcommands=(",
  ];

  for (const child of node.children) {
    const description = child.description || "command";
    lines.push(`        ${quoteForZsh(`${escapeDescribeText(child.path[child.path.length - 1] ?? "command")}:${escapeDescribeText(description)}`)}`);
  }

  lines.push("      )");
  lines.push(`      _describe -t commands ${quoteForZsh(describeLabel)} subcommands`);
  lines.push("      return");
  lines.push("      ;;");
  lines.push("  esac");

  return lines;
}

function renderCommandFunction(node: CompletionCommandNode): string[] {
  const lines = [`${node.functionName}() {`, "  local curcontext=\"$curcontext\" state line", "  typeset -A opt_args"];
  const shiftCount = node.path.length;

  if (shiftCount > 0) {
    lines.push("  local -a shifted_words");
    lines.push(`  shifted_words=("\${(@)words[${shiftCount + 1},-1]}")`);
    lines.push("  local -a words");
    lines.push('  words=("${shifted_words[@]}")');
    lines.push(`  local CURRENT=$(( CURRENT - ${shiftCount} ))`);
  }

  if (node.children.length > 0) {
    lines.push('  local subcommand_name="${words[2]-}"');
    lines.push("  case \"$subcommand_name\" in");
    for (const child of node.children) {
      const childName = child.path[child.path.length - 1];
      lines.push(`    ${quoteForZsh(childName)} )`);
      lines.push(`      ${child.functionName}`);
      lines.push("      return");
      lines.push("      ;;");
    }
    lines.push("  esac");
  }

  lines.push(...renderArgumentsInvocation(node));
  lines.push(...renderSubcommandCase(node));
  lines.push("}");

  return lines;
}

function flattenCommandFunctions(node: CompletionCommandNode): string[] {
  const lines = renderCommandFunction(node);
  for (const child of node.children) {
    lines.push("");
    lines.push(...flattenCommandFunctions(child));
  }
  return lines;
}

function sanitizeSuggestionText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

function sanitizeSuggestionDescription(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

function sortSuggestions(items: CompletionSuggestion[]): CompletionSuggestion[] {
  return [...items].sort((left, right) => left.value.localeCompare(right.value));
}

function describeProject(config: OrchestratorConfig, projectId: string): string | undefined {
  const project = config.projects[projectId];
  if (!project) return undefined;

  const parts = [project.name, project.repo, project.path].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

  return parts.length > 0 ? parts.join(" - ") : undefined;
}

async function listProjects(): Promise<CompletionSuggestion[]> {
  try {
    // Merge projects from both local config (cwd-based) and global config
    // so completions show all registered projects regardless of cwd.
    const seen = new Map<string, CompletionSuggestion>();

    try {
      const config = loadConfig();
      for (const projectId of Object.keys(config.projects)) {
        seen.set(projectId, {
          value: projectId,
          description: describeProject(config, projectId),
        });
      }
    } catch {
      // No local config found — that's fine, global may still have projects
    }

    try {
      const globalConfig = loadGlobalConfig(getGlobalConfigPath());
      if (globalConfig) {
        for (const [projectId, entry] of Object.entries(globalConfig.projects)) {
          if (seen.has(projectId)) continue;
          const parts = [entry.displayName, entry.repo ? `${entry.repo.owner}/${entry.repo.name}` : undefined, entry.path].filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          );
          seen.set(projectId, {
            value: projectId,
            description: parts.length > 0 ? parts.join(" - ") : undefined,
          });
        }
      }
    } catch {
      // Global config unavailable — use whatever we have
    }

    return sortSuggestions([...seen.values()]);
  } catch {
    return [];
  }
}

function describeSession(session: Session): string | undefined {
  const parts = [session.projectId];
  if (session.status) {
    parts.push(`[${session.status}]`);
  }
  return parts.join(" ");
}

async function listSessions(options: CompletionDataOptions): Promise<CompletionSuggestion[]> {
  try {
    const config = loadConfig();
    const sessionManager = await getSessionManager(config);
    const sessions = await sessionManager.list();

    const filtered = sessions.filter((session) => {
      if (!options.includeOrchestrators) {
        const isOrchestrator = isOrchestratorSessionName(config, session.id, session.projectId);
        if (isOrchestrator) return false;
      }

      if (!options.includeTerminated && isTerminalSession(session)) {
        return false;
      }

      return true;
    });

    return sortSuggestions(
      filtered.map((session) => ({
        value: session.id,
        description: describeSession(session),
      })),
    );
  } catch {
    return [];
  }
}

async function listOpenTargets(): Promise<CompletionSuggestion[]> {
  const [projects, sessions] = await Promise.all([listProjects(), listSessions({})]);
  return [
    { value: "all", description: "Open every session" },
    ...projects,
    ...sessions,
  ];
}

export async function getCompletionSuggestions(
  kind: string,
  options: CompletionDataOptions = {},
): Promise<CompletionSuggestion[]> {
  if (kind === "projects") {
    return await listProjects();
  }
  if (kind === "sessions") {
    return await listSessions(options);
  }
  if (kind === "open-targets") {
    return await listOpenTargets();
  }

  return [];
}

export function formatCompletionSuggestions(items: readonly CompletionSuggestion[]): string {
  return items
    .map((item) => {
      const value = sanitizeSuggestionText(item.value);
      const description = item.description ? sanitizeSuggestionDescription(item.description) : "";
      return description ? `${value}\t${description}` : value;
    })
    .join("\n");
}

function formatStaticSuggestions(items: readonly CompletionSuggestion[]): string[] {
  return describeEntries(items);
}

function formatReportedStateSuggestions(): CompletionSuggestion[] {
  const canonicalDescriptions = new Map(
    REPORT_STATE_SUGGESTIONS.map((entry) => [entry.value.replace(/-/g, "_"), entry.description]),
  );

  return AGENT_REPORTED_STATES.map((state) => ({
    value: state.replace(/_/g, "-"),
    description: canonicalDescriptions.get(state) ?? "Report state",
  }));
}

export function generateZshCompletion(program: Command): string {
  const tree = buildCommandTree(program, []);
  const pluginSlots = formatStaticSuggestions(PLUGIN_SLOT_SUGGESTIONS).join("\n        ");
  const reportStates = formatStaticSuggestions(formatReportedStateSuggestions()).join("\n        ");
  const functions = flattenCommandFunctions(tree).join("\n");

  return `#compdef ao

_ao_dynamic_describe() {
  local tag="$1"
  local label="$2"
  local kind="$3"
  shift 3

  local -a items
  local value description
  while IFS=$'\\t' read -r value description; do
    [[ -n "$value" ]] || continue
    if [[ -n "$description" ]]; then
      description=\${description//:/\\\\:}
      items+=("\${value}:\${description}")
    else
      items+=("\${value}")
    fi
  done < <(command ao __complete "$kind" "$@" 2>/dev/null)

  (( \${#items[@]} )) || return 1
  _describe -t "$tag" "$label" items
}

_ao_complete_projects() {
  _ao_dynamic_describe projects "configured project" projects
}

_ao_complete_sessions() {
  _ao_dynamic_describe sessions "active session" sessions
}

_ao_complete_all_sessions() {
  _ao_dynamic_describe sessions "session" sessions --include-terminated
}

_ao_complete_open_targets() {
  _ao_dynamic_describe targets "open target" open-targets
}

_ao_complete_start_target() {
  _alternative \\
    'projects:configured project:_ao_complete_projects' \\
    'paths:path:_files'
}

_ao_complete_plugin_slots() {
  local -a slots
  slots=(
        ${pluginSlots}
  )
  _describe -t plugin-slots "plugin slot" slots
}

_ao_complete_report_states() {
  local -a states
  states=(
        ${reportStates}
  )
  _describe -t report-states "report state" states
}

${functions}

_ao "$@"
`;
}
