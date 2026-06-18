#!/usr/bin/env node
/**
 * Windows-specific script to kill Node processes holding locks on .next directory
 * This is a workaround for Windows file locking issues
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("This script is Windows-only. Exiting.");
  process.exit(0);
}

const webDir = join(process.cwd());

try {
  // Use handle.exe if available to find which process is holding the lock
  // Otherwise, use a more targeted approach
  console.log("Checking for processes using .next directory...");

  // Try to find processes with handles to the .next directory
  // This requires handle.exe from Sysinternals
  try {
    const output = execFileSync("handle", [webDir], { encoding: "utf8" });
    console.log(output);
  } catch {
    console.log("handle.exe not available. Checking for Next.js dev processes...");

    // Find Node processes that might be Next.js dev servers
    const output = execFileSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });

    const lines = output.trim().split("\n");
    const pids = [];

    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        const pid = parts[1].replace(/"/g, "").trim();
        if (pid && /^\d+$/.test(pid)) {
          pids.push(pid);
        }
      }
    }

    if (pids.length === 0) {
      console.log("No Node processes found.");
      process.exit(0);
    }

    console.log(`Found ${pids.length} Node process(es).`);
    console.log("WARNING: This will kill ALL Node processes including Cursor, Discord, etc.");
    console.log(
      "If you only want to kill the dev server, use Ctrl+C in the terminal where it's running.",
    );
    console.log("To proceed, run: taskkill /F /PID <pid>");
    console.log("\nOr install handle.exe from Sysinternals for targeted lock detection:");
    console.log("https://learn.microsoft.com/en-us/sysinternals/downloads/handle");
  }
} catch (error) {
  console.error("Error:", error.message);
  process.exit(1);
}
