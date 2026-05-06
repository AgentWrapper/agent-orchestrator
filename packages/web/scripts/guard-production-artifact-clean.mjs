#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

function canonicalPath(path) {
  try {
    return normalize(realpathSync(path));
  } catch {
    return normalize(resolve(path));
  }
}

const webDir = canonicalPath(process.cwd());
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

function execText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch (error) {
    return error && error.code === "ENOENT" ? null : "";
  }
}

function lsof(args) {
  return execText("lsof", args);
}

function processCwd(pid) {
  const output = lsof(["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  if (!output) return null;
  const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
  return cwdLine ? canonicalPath(cwdLine.slice(1)) : null;
}

function pidsListeningOnPort(port) {
  const lsofOutput = lsof(["-ti", `:${port}`, "-sTCP:LISTEN"]);
  if (lsofOutput !== null) {
    return lsofOutput
      .split("\n")
      .map((pid) => pid.trim())
      .filter((pid) => /^\d+$/.test(pid));
  }

  if (process.platform !== "win32") return [];

  const netstatOutput = execText("netstat", ["-ano", "-p", "tcp"]);
  if (!netstatOutput) return [];

  return netstatOutput
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 5)
    .filter((columns) => columns[1]?.endsWith(`:${port}`) && columns[3] === "LISTENING")
    .map((columns) => columns[4])
    .filter((pid) => typeof pid === "string" && /^\d+$/.test(pid));
}

const running = readRunningState();
if (running) {
  const pids = pidsListeningOnPort(running.port);
  const matchingPid =
    process.platform === "win32" ? pids[0] : pids.find((pid) => processCwd(pid) === webDir);

  if (matchingPid) {
    const checkoutDetail =
      process.platform === "win32"
        ? "AO dashboard is running on the configured port"
        : "AO dashboard is running from this checkout";
    console.error(
      `Refusing to delete production dashboard artifacts while ${checkoutDetail} (PID ${matchingPid}, port ${running.port}).\n` +
        "Stop it first with `ao stop`, or rebuild through `ao start --rebuild` / `ao dashboard --rebuild` so AO can stop the old dashboard safely.",
    );
    process.exit(1);
  }
}
