#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input || "{}");
    const droidSessionId = typeof event.session_id === "string" ? event.session_id.trim() : "";
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(droidSessionId)) return;

    const aoDataDir = process.env.AO_DATA_DIR;
    const aoSession = process.env.AO_SESSION || process.env.AO_SESSION_ID;
    if (!aoDataDir || !aoSession || !/^[A-Za-z0-9._:-]{1,200}$/.test(aoSession)) return;

    const metadataPath = path.join(aoDataDir, aoSession + ".json");
    let metadata = {};
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
    } catch {
      metadata = {};
    }

    metadata.droidSessionId = droidSessionId;
    if (typeof event.transcript_path === "string" && event.transcript_path.trim()) {
      metadata.droidTranscriptPath = event.transcript_path.trim();
    }

    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    const tmpPath = metadataPath + ".tmp-" + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + "\n");
    fs.renameSync(tmpPath, metadataPath);
  } catch {
    // Best effort: metadata capture must never affect Droid startup or prompts.
  }
});
