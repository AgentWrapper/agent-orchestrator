#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

try {
  execFileSync("rimraf", [".next", "dist-server"], { stdio: "inherit" });
} catch (error) {
  console.warn("Cleanup failed (likely file lock), continuing...");
  // Don't exit with error, allow build to proceed
}
