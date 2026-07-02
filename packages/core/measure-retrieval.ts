// Ф2-LITE measurement script — not committed to package build, run once via tsx.
import { assembleContextBundle } from "./src/retrieval/index.js";
import { seedRlmContext } from "./src/rlm-seed.js";

const PROJECT_ID = "maestro-mac_bfd91d1315";
const PROJECT_ROOT = "/Volumes/media/ai_team_soft/maestro-mac";

const TASKS = [
  "fix chat scroll jitter when streaming tokens in the webview",
  "add AO_SDK_EFFORT wiring so the selected reasoning effort reaches the SDK at spawn",
  "build and notarize a release DMG and publish the appcast",
  "phantom-diff: stop AO-injected .claude files leaking into worker git diffs",
  "OpenAI Responses provider native driver for gpt models",
];

async function main() {
  for (const taskText of TASKS) {
    console.log("\n=== TASK:", taskText, "===");

    const bundle = await assembleContextBundle(
      { projectId: PROJECT_ID, projectRoot: PROJECT_ROOT, taskText },
      { ensureGraphBuiltFn: async () => true },
    );

    if (!bundle) {
      console.log("FUSED: null bundle");
    } else {
      console.log("FUSED tokens:", bundle.json.tokensPacked, JSON.stringify(bundle.json));
      console.log("FUSED markdown:\n" + bundle.markdown);
    }

    const legacy = await seedRlmContext({ projectId: PROJECT_ID, taskText });
    if (!legacy) {
      console.log("LEGACY: null");
    } else {
      const legacyTokens = Math.ceil(legacy.length / 4);
      console.log("LEGACY tokens (approx):", legacyTokens);
      console.log("LEGACY markdown:\n" + legacy);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
