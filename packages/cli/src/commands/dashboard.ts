import { spawn } from "node:child_process";
import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@aoagents/ao-core";
import { findWebDir, buildDashboardEnv, waitForPortAndOpen } from "../lib/web-dir.js";
import {
  clearStaleCacheIfNeeded,
  isInstalledUnderNodeModules,
  rebuildDashboardProductionArtifacts,
} from "../lib/dashboard-rebuild.js";
import { preflight } from "../lib/preflight.js";
import { DEFAULT_PORT } from "../lib/constants.js";

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("Start the web dashboard")
    .option("-p, --port <port>", "Port to listen on")
    .option("--no-open", "Don't open browser automatically")
    .option("--rebuild", "Clean stale build artifacts and rebuild before starting")
    /* c8 ignore start -- process-spawning startup code, tested via integration/onboarding */
    .action(async (opts: { port?: string; open?: boolean; rebuild?: boolean }) => {
      const config = loadConfig();
      const port = opts.port ? parseInt(opts.port, 10) : (config.port ?? DEFAULT_PORT);

      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(chalk.red("Invalid port number. Must be 1-65535."));
        process.exit(1);
      }

      const localWebDir = findWebDir(); // throws with install-specific guidance if not found

      if (opts.rebuild) {
        await rebuildDashboardProductionArtifacts(localWebDir, [port]);
        // Fall through to start the dashboard on this port.
      } else {
        await preflight.checkBuilt(localWebDir);
        await clearStaleCacheIfNeeded(localWebDir);
      }

      const webDir = localWebDir;

      console.log(chalk.bold(`Starting dashboard on http://localhost:${port}\n`));

      const env = await buildDashboardEnv(
        port,
        config.configPath,
        config.terminalPort,
        config.directTerminalPort,
      );

      const startScript = resolve(webDir, "dist-server", "start-all.js");
      const child = spawn("node", [startScript], {
        cwd: webDir,
        stdio: ["inherit", "inherit", "pipe"],
        env,
      });

      const stderrChunks: string[] = [];

      const MAX_STDERR_CHUNKS = 100;

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        if (stderrChunks.length < MAX_STDERR_CHUNKS) {
          stderrChunks.push(text);
        }
        // Still show stderr to the user
        process.stderr.write(data);
      });

      child.on("error", (err) => {
        console.error(chalk.red("Could not start dashboard. Ensure Next.js is installed."));
        console.error(chalk.dim(String(err)));
        process.exit(1);
      });

      let openAbort: AbortController | undefined;

      if (opts.open !== false) {
        openAbort = new AbortController();
        void waitForPortAndOpen(port, `http://localhost:${port}`, openAbort.signal);
      }

      child.on("exit", (code) => {
        if (openAbort) openAbort.abort();

        if (code !== 0 && code !== null && !opts.rebuild) {
          const stderr = stderrChunks.join("");
          if (looksLikeStaleBuild(stderr)) {
            const recoveryCommand = isInstalledUnderNodeModules(webDir)
              ? "npm install -g @aoagents/ao@latest"
              : "ao dashboard --rebuild";
            console.error(
              chalk.yellow(
                "\nThis looks like a stale build cache issue. Try:\n\n" +
                  `  ${chalk.cyan(recoveryCommand)}\n`,
              ),
            );
          }
        }

        process.exit(code ?? 0);
      });
      /* c8 ignore stop */
    });
}

/**
 * Check if stderr output suggests stale build artifacts.
 */
function looksLikeStaleBuild(stderr: string): boolean {
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];
  return patterns.some((p) => p.test(stderr));
}
