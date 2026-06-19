export interface CommandErrorOptions {
  cmd: string;
  args?: string[];
  action?: string;
  installHints?: string[];
}

function formatHints(hints: string[] | undefined): string {
  if (!hints || hints.length === 0) return "";
  return `\nInstall hint${hints.length === 1 ? "" : "s"}:\n  ${hints.join("\n  ")}`;
}

export function formatCommandError(err: unknown, options: CommandErrorOptions): Error {
  const command = [options.cmd, ...(options.args ?? [])].join(" ").trim();
  const action = options.action ?? "run the command";
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (code === "ENOENT") {
    return new Error(
      `${options.cmd} is not installed or not on PATH, so AO could not ${action}.${formatHints(options.installHints)}`,
    );
  }

  if (code === "EACCES") {
    return new Error(
      `${options.cmd} exists but AO could not execute it due to a permission error while trying to ${action}. ` +
        `Check that the binary is executable and accessible to this user.${formatHints(options.installHints)}`,
    );
  }

  return new Error(`Failed to ${action}: ${command}${message ? `\n${message}` : ""}`);
}
