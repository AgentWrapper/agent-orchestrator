import type { Command } from "commander";
import {
  formatCompletionSuggestions,
  generateZshCompletion,
  getCompletionSuggestions,
} from "../lib/completion.js";

export function registerCompletion(program: Command): void {
  const completion = program
    .command("completion")
    .description("Generate shell completion scripts");

  completion
    .command("zsh")
    .description("Print the zsh completion script")
    .action(() => {
      process.stdout.write(generateZshCompletion(program));
    });

  program
    .command("__complete", { hidden: true })
    .description("Internal helper for shell completions")
    .argument("<kind>", "Completion data kind")
    .option("--include-terminated", "Include terminated sessions")
    .option("--include-orchestrators", "Include orchestrator sessions")
    .action(
      async (
        kind: string,
        opts: { includeTerminated?: boolean; includeOrchestrators?: boolean },
      ) => {
        const suggestions = await getCompletionSuggestions(kind, opts);
        const output = formatCompletionSuggestions(suggestions);
        if (output.length > 0) {
          process.stdout.write(`${output}\n`);
        }
      },
    );
}
