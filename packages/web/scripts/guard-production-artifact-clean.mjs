#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, normalize, join } from "node:path";
import { execFileSync } from "node:child_process";

const webDir = normalize(resolve(process.cwd()));
const runningPath = join(homedir(), ".agent-orchestrator", "running.json");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function readRunningState() {
  try {
    const parsed = JSON.parse(readFileSync(runningPath, "utf8"));
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.port !== "number") return null;
    if (!isPidAlive(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function lsof(args) {
  try {
    return execFileSync("lsof", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function processCwd(pid) {
  const output = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
  return cwdLine ? normalize(cwdLine.slice(1)) : null;
}

const running = readRunningState();
if (running) {
  const pids = lsof(["-ti", `:${running.port}`, "-sTCP:LISTEN"])
    .split("\n")
    .map((pid) => pid.trim())
    .filter((pid) => /^\d+$/.test(pid));

  const matchingPid = pids.find((pid) => processCwd(pid) === webDir);
  if (matchingPid) {
    console.error(
      `Refusing to delete production dashboard artifacts while AO dashboard is running from this checkout (PID ${matchingPid}, port ${running.port}).\n` +
        "Stop it first with `ao stop`, or rebuild through `ao start --rebuild` / `ao dashboard --rebuild` so AO can stop the old dashboard safely.",
    );
    process.exit(1);
  }
}
