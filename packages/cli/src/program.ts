import { Command } from "commander";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerAcknowledge, registerReport } from "./commands/report.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerVerify } from "./commands/verify.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerUpdate } from "./commands/update.js";
import { registerSetup } from "./commands/setup.js";
import { registerPlugin } from "./commands/plugin.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerMigrateStorage } from "./commands/migrate-storage.js";
import { registerCompletion } from "./commands/completion.js";
import { registerEvents } from "./commands/events.js";
import { getConfigInstruction } from "./lib/config-instruction.js";
import { getCliVersion } from "./options/version.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("ao")
    .description("Agent Orchestrator — manage parallel AI coding agents")
    .version(getCliVersion());

  registerStart(program);
  registerStop(program);
  registerStatus(program);
  registerSpawn(program);
  registerBatchSpawn(program);
  registerSession(program);
  registerSend(program);
  registerAcknowledge(program);
  registerReport(program);
  registerReviewCheck(program);
  registerDashboard(program);
  registerOpen(program);
  registerVerify(program);
  registerDoctor(program);
  registerUpdate(program);
  registerSetup(program);
  registerPlugin(program);
  registerProjectCommand(program);
  registerMigrateStorage(program);
  registerCompletion(program);
  registerEvents(program);

  program
    .command("config-help")
    .description("Show config schema and guide for creating agent-orchestrator.yaml")
    .action(() => {
      console.log(getConfigInstruction());
    });

  return program;
}
