#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..", "dist", "AO Notifier.app");
const zipPath = resolve(__dirname, "..", "dist", "AO Notifier.zip");

const appleId = process.env["APPLE_NOTARY_APPLE_ID"];
const teamId = process.env["APPLE_NOTARY_TEAM_ID"];
const password = process.env["APPLE_NOTARY_PASSWORD"];

if (process.platform !== "darwin") {
  console.log("Skipping macOS notarization on non-darwin platform.");
  process.exit(0);
}

if (!appleId || !teamId || !password) {
  console.error(
    "Set APPLE_NOTARY_APPLE_ID, APPLE_NOTARY_TEAM_ID, and APPLE_NOTARY_PASSWORD to notarize.",
  );
  process.exit(1);
}

if (!existsSync(appDir)) {
  console.error(`Missing app bundle: ${appDir}`);
  process.exit(1);
}

rmSync(zipPath, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", appDir, zipPath], { stdio: "inherit" });
execFileSync(
  "xcrun",
  [
    "notarytool",
    "submit",
    zipPath,
    "--apple-id",
    appleId,
    "--team-id",
    teamId,
    "--password",
    password,
    "--wait",
  ],
  { stdio: "inherit" },
);
execFileSync("xcrun", ["stapler", "staple", appDir], { stdio: "inherit" });
console.log("Notarized and stapled AO Notifier.app.");
