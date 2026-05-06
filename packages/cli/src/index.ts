#!/usr/bin/env node

import { maybeShowUpdateNotice, scheduleBackgroundRefresh } from "./lib/update-check.js";

// Synchronous cache read — no network call on startup.
maybeShowUpdateNotice();

import { ConfigNotFoundError } from "@aoagents/ao-core";
import { createProgram } from "./program.js";

createProgram()
  .parseAsync()
  .catch((err) => {
    if (err instanceof ConfigNotFoundError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
      return;
    }
    throw err;
  })
  .then(() => {
    // Background cache refresh after command completes. Runs in a detached
    // setTimeout so the process can exit without waiting for the fetch.
    // Placed after parseAsync to avoid holding the event loop open during
    // short-lived commands when the registry is slow/offline.
    scheduleBackgroundRefresh();
  });
