#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..", "dist", "AO Notifier.app");
const identity = process.env["APPLE_CODESIGN_IDENTITY"] ?? "-";

if (process.platform !== "darwin") {
  console.log("Skipping macOS signing on non-darwin platform.");
  process.exit(0);
}

if (!existsSync(appDir)) {
  console.error(`Missing app bundle: ${appDir}`);
  process.exit(1);
}

execFileSync("codesign", ["--force", "--deep", "--options", "runtime", "--sign", identity, appDir], {
  stdio: "inherit",
});
console.log(`Signed AO Notifier.app with ${identity === "-" ? "ad-hoc identity" : identity}.`);
