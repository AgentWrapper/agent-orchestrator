import { spawn } from "node:child_process";

const WATCH_ARGS = ["watch", "server/direct-terminal-ws.ts"];
const FALLBACK_ARGS = ["server/direct-terminal-ws.ts"];

let shuttingDown = false;

function wireSignals(child) {
  const forward = (signal) => {
    shuttingDown = true;
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
}

function shouldFallback(code, stderr) {
  if (code === 0) return false;
  return (
    stderr.includes("createIpcServer") &&
    stderr.includes("EPERM") &&
    stderr.includes("operation not permitted")
  );
}

function runTsx(args, { allowFallback }) {
  const child = spawn("tsx", args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > 16_384) {
      stderrBuffer = stderrBuffer.slice(-16_384);
    }
    process.stderr.write(chunk);
  });

  wireSignals(child);

  child.on("close", (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }

    if (allowFallback && shouldFallback(code ?? 1, stderrBuffer)) {
      console.warn(
        "[dev:direct-terminal] tsx watch IPC setup failed; falling back to non-watch mode.",
      );
      runTsx(FALLBACK_ARGS, { allowFallback: false });
      return;
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[dev:direct-terminal] Failed to start tsx:", error);
    process.exit(1);
  });
}

runTsx(WATCH_ARGS, { allowFallback: true });
