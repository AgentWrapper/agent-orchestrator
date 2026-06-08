import type { Command } from "commander";
import chalk from "chalk";
import {
  createPluginRegistry,
  findConfigFile,
  loadConfig,
  type OrchestratorConfig,
  type PluginRegistry,
} from "@aoagents/ao-core";
import { importPluginModuleFromSource } from "../lib/plugin-store.js";
import {
  addSinkNotifierConfig,
  parseNotifyDataJson,
  parseNotifyRefs,
  parseSinkPort,
  runNotifyTest,
  startNotifySink,
  type NotifySinkServer,
  type NotifyTestRequest,
  type NotifyTestResult,
} from "../lib/notify-test.js";

interface NotifyTestCommandOptions {
  template?: string;
  to?: string;
  all?: boolean;
  route?: string;
  actions?: boolean;
  message?: string;
  session?: string;
  project?: string;
  priority?: string;
  type?: string;
  data?: string;
  dryRun?: boolean;
  json?: boolean;
  sink?: true | string;
}

async function loadNotifierRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, importPluginModuleFromSource);
  return registry;
}

function printJson(result: NotifyTestResult, sinkRequests?: unknown[]): void {
  console.log(
    JSON.stringify(
      {
        ...result,
        sinkRequests,
      },
      null,
      2,
    ),
  );
}

function printHumanResult(result: NotifyTestResult, sinkRequests?: unknown[]): void {
  console.log(
    `${result.dryRun ? "Dry run" : "Sent"} ${result.templateName} notification (${result.event.type}, ${result.event.priority})`,
  );
  console.log(`Event id: ${result.event.id}`);
  console.log(`Session: ${result.event.projectId}/${result.event.sessionId}`);

  if (result.targets.length > 0) {
    console.log("");
    console.log("Targets:");
    for (const target of result.targets) {
      console.log(`  ${target.reference} -> ${target.pluginName}`);
    }
  }

  if (result.deliveries.length > 0) {
    console.log("");
    console.log("Delivery:");
    for (const delivery of result.deliveries) {
      if (delivery.status === "sent") {
        console.log(`  ${chalk.green("PASS")} ${delivery.reference}: ${delivery.method}`);
      } else if (delivery.status === "dry_run") {
        console.log(`  ${chalk.cyan("DRY")}  ${delivery.reference}: ${delivery.method}`);
      } else {
        console.log(`  ${chalk.red("FAIL")} ${delivery.reference}: ${delivery.error}`);
      }
    }
  }

  for (const warning of result.warnings) {
    console.log(`${chalk.yellow("WARN")} ${warning}`);
  }

  for (const error of result.errors) {
    console.error(`${chalk.red("FAIL")} ${error}`);
  }

  if (sinkRequests && sinkRequests.length > 0) {
    console.log("");
    console.log("Sink received:");
    console.log(JSON.stringify(sinkRequests[0], null, 2));
  }
}

function commandRequest(opts: NotifyTestCommandOptions, forceSinkTarget: boolean): NotifyTestRequest {
  const request: NotifyTestRequest = {
    templateName: opts.template,
    to: forceSinkTarget ? ["sink"] : parseNotifyRefs(opts.to),
    all: opts.all,
    route: opts.route,
    actions: opts.actions,
    message: opts.message,
    sessionId: opts.session,
    projectId: opts.project,
    priority: opts.priority,
    type: opts.type,
    data: parseNotifyDataJson(opts.data),
    dryRun: opts.dryRun,
  };

  return request;
}

export function registerNotify(program: Command): void {
  const notify = program.command("notify").description("Work with configured notification targets");

  notify
    .command("test")
    .description("Send a manual demo notification without spawning sessions")
    .option("--template <name>", "Demo template to send", "basic")
    .option("--to <refs>", "Comma-separated notifier refs to target")
    .option("--all", "Send to all configured, default, and routed notifier refs")
    .option("--route <urgent|action|warning|info>", "Send through a priority route")
    .option("--actions", "Send demo actions when supported")
    .option("--message <text>", "Override the notification message")
    .option("--session <id>", "Override the demo session id")
    .option("--project <id>", "Override the demo project id")
    .option("--priority <level>", "Override the event priority")
    .option("--type <eventType>", "Override the event type")
    .option("--data <json>", "Merge JSON object into the event data")
    .option("--dry-run", "Resolve and print the notification without sending it")
    .option("--json", "Print structured JSON output")
    .option("--sink [port]", "Add an in-memory local webhook target named sink")
    .action(async (opts: NotifyTestCommandOptions) => {
      let sink: NotifySinkServer | undefined;
      let exitCode = 0;

      try {
        const sinkPort = parseSinkPort(opts.sink);
        const forceSinkTarget = sinkPort !== undefined && !opts.to && !opts.all && !opts.route;
        const request = commandRequest(opts, forceSinkTarget);

        const configPath = findConfigFile();
        if (!configPath) {
          throw new Error("No config file found. Cannot test notifiers without agent-orchestrator.yaml");
        }

        let config: OrchestratorConfig = loadConfig(configPath);
        if (sinkPort !== undefined) {
          const sinkUrl = opts.dryRun ? `http://127.0.0.1:${sinkPort}` : undefined;
          if (!opts.dryRun) {
            sink = await startNotifySink(sinkPort);
          }
          config = addSinkNotifierConfig(config, sink?.url ?? sinkUrl ?? "http://127.0.0.1:0");
        }

        const registry = await loadNotifierRegistry(config);
        const result = await runNotifyTest(config, registry, request);
        const sinkRequest = sink ? await sink.waitForRequest(1000) : null;
        const sinkRequests = sinkRequest ? [sinkRequest] : sink?.requests;

        if (opts.json) {
          printJson(result, sinkRequests);
        } else {
          printHumanResult(result, sinkRequests);
        }

        if (!result.ok) {
          exitCode = 1;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, errors: [message] }, null, 2));
        } else {
          console.error(`${chalk.red("FAIL")} ${message}`);
        }
        exitCode = 1;
      } finally {
        if (sink) {
          await sink.close();
        }
      }

      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });
}
