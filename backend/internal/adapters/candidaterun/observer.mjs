import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

function fail(message) {
  throw new Error(message);
}

async function readBinding(configPath) {
  if (!path.isAbsolute(configPath)) {
    fail("candidate run config path must be absolute");
  }
  const entry = await lstat(configPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail("candidate run config must be a regular non-link file");
  }
  const binding = JSON.parse(await readFile(configPath, "utf8"));
  const allowed = new Set([
    "schemaVersion",
    "nodeBinary",
    "journalDirectory",
    "kernel",
    "controllerClaim",
    "codex",
    "activationProfile",
    "prepared",
  ]);
  for (const key of Object.keys(binding)) {
    if (!allowed.has(key)) fail(`candidate run config ${key} is not allowed`);
  }
  if (binding.schemaVersion !== 1) {
    fail("candidate run config schemaVersion must be 1");
  }
  if (binding.activationProfile?.schemaVersion !== 2) {
    fail("candidate run activation profile must use schemaVersion 2");
  }
  return binding;
}

async function loadKernel(binding) {
  const modulePath = binding.kernel?.modulePath;
  if (!path.isAbsolute(modulePath ?? "")) {
    fail("candidate run kernel module path must be absolute");
  }
  const entry = await lstat(modulePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail("candidate run kernel module must be a regular non-link file");
  }
  const bytes = await readFile(modulePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== binding.kernel?.sha256) {
    fail("candidate run kernel digest does not match");
  }
  return import(pathToFileURL(modulePath).href);
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const configPath = process.argv.at(-1);
const binding = await readBinding(configPath);
const candidateRun = await loadKernel(binding);
const controllerInstanceId =
  `agent-orchestrator:${process.pid}:${randomUUID()}`;
const journal = candidateRun.createRuntimeJournal({
  directory: binding.journalDirectory,
  runId: binding.prepared.runId,
  controllerId: binding.prepared.controllerOwner,
});
const kernel = candidateRun.createCandidateRunKernel({
  mode: "observer",
  prepared: binding.prepared,
  activationProfile: binding.activationProfile,
  controllerId: binding.prepared.controllerOwner,
  controllerInstanceId,
  journal,
});
const configureRequest = {
  eventId: binding.controllerClaim.eventId,
  claimId: binding.controllerClaim.claimId,
  at: binding.controllerClaim.claimedAt,
};
const configured = await kernel.configure(configureRequest);
writeFrame({ type: "ready", controllerInstanceId });

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

for await (const line of lines) {
  let request;
  try {
    request = JSON.parse(line);
    if (!Number.isInteger(request.id) || request.id < 1) {
      fail("candidate run observer request id is invalid");
    }
    let result;
    if (request.method === "configure") {
      result = await kernel.configure(configureRequest);
    } else if (request.method === "observe") {
      result = await kernel.observe(request.params?.event);
    } else {
      fail(`candidate run observer method ${String(request.method)} is not allowed`);
    }
    writeFrame({ id: request.id, ok: true, result });
  } catch (error) {
    writeFrame({
      id: Number.isInteger(request?.id) ? request.id : 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
