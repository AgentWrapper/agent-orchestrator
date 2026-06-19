#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

try {
  // On Windows, the .next/trace file often gets locked by Node.js processes
  // Skip it and continue with the rest of the cleanup
  const tracePath = join(process.cwd(), ".next", "trace");
  if (process.platform === "win32" && existsSync(tracePath)) {
    try {
      unlinkSync(tracePath);
    } catch (error) {
      // Ignore EPERM on trace file - it's a build artifact that will be regenerated
      if (error.code !== "EPERM") {
        throw error;
      }
    }
  }

  execFileSync("rimraf", [".next", "dist-server"], { stdio: "inherit" });
} catch {
  console.warn("Cleanup failed (likely file lock), continuing...");
  // Don't exit with error, allow build to proceed
}
