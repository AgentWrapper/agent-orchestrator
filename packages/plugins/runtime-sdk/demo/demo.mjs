/**
 * runtime-sdk demo — drives a real 2-turn streaming session through Claude via
 * the Agent SDK, prints the live normalized event stream, then RESUMES the
 * session by id and continues.
 *
 * Prereqs: a working Claude login (the same one Claude Code uses; no API key
 * needed), and a built plugin:
 *   pnpm --filter @aoagents/ao-plugin-runtime-sdk build
 *   node packages/plugins/runtime-sdk/demo/demo.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "../dist/index.js";
import { subscribeSession } from "../dist/sdk-client.js";

const work = await mkdtemp(join(tmpdir(), "sdk-demo-"));
const env = { AO_SDK_PERMISSION_MODE: "bypassPermissions", AO_SDK_HOME: join(work, ".state") };
const runtime = create();

function render(tag, e) {
  if (e.type === "text-delta") process.stdout.write(e.text);
  else if (e.type === "reasoning") process.stdout.write(`\x1b[2m${e.text}\x1b[0m`);
  else if (e.type === "session") console.log(`\n[${tag}] session/${e.subtype} id=${e.session_id}`);
  else if (e.type === "tool_use") console.log(`\n[${tag}] tool_use ${e.name} ${JSON.stringify(e.input)}`);
  else if (e.type === "tool_result") console.log(`\n[${tag}] tool_result is_error=${e.is_error}`);
  else if (e.type === "result") console.log(`\n[${tag}] result/${e.subtype} (turn ${e.num_turns}, ${e.duration_ms}ms)`);
  else if (e.type === "usage") console.log(`[${tag}] usage in=${e.input_tokens} out=${e.output_tokens} cost=$${e.total_cost_usd}`);
}

const events = [];
function waitForResult() {
  const start = events.length;
  return new Promise((res) => {
    const t = setInterval(() => {
      if (events.slice(start).some((e) => e.type === "result")) {
        clearInterval(t);
        res();
      }
    }, 100);
  });
}

console.log("=== SESSION 1 — two streaming turns ===");
const h1 = await runtime.create({ sessionId: "demo-1", workspacePath: work, launchCommand: "", environment: env });
const sub1 = await subscribeSession(h1.data.socketPath, (e) => {
  events.push(e);
  render("s1", e);
});

let done = waitForResult();
console.log("\n--- turn 1 ---");
await runtime.sendMessage(h1, "Remember the secret word GIRAFFE. Reply with just: OK");
await done;

done = waitForResult();
console.log("\n--- turn 2 ---");
await runtime.sendMessage(h1, "Reply with the secret word in lowercase, nothing else.");
await done;

const init = events.find((e) => e.type === "session" && e.subtype === "init");
const sdkSessionId = init?.session_id;
console.log(`\n\n>>> captured provider session_id = ${sdkSessionId}`);
sub1.close();
await runtime.destroy(h1);
console.log(">>> session 1 destroyed\n");

console.log("=== SESSION 2 — RESUME by id, continue ===");
const r = [];
const h2 = await runtime.create({
  sessionId: "demo-2",
  workspacePath: work,
  launchCommand: "",
  environment: { ...env, AO_SDK_RESUME: sdkSessionId },
});
const sub2 = await subscribeSession(h2.data.socketPath, (e) => {
  r.push(e);
  render("s2", e);
});
const resumeDone = new Promise((res) => {
  const t = setInterval(() => {
    if (r.some((e) => e.type === "result")) {
      clearInterval(t);
      res();
    }
  }, 100);
});
console.log("\n--- resumed turn ---");
await runtime.sendMessage(h2, "What was the secret word I told you earlier? Reply with just that word.");
await resumeDone;

sub2.close();
await runtime.destroy(h2);
await rm(work, { recursive: true, force: true });
console.log("\n\n=== DEMO COMPLETE — resume remembered context across a fresh host ===");
process.exit(0);
