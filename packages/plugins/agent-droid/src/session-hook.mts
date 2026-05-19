#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

interface DroidHookEvent {
  session_id?: unknown;
  transcript_path?: unknown;
}

interface DroidSessionMetadata {
  droidSessionId?: string;
  droidTranscriptPath?: string;
  [key: string]: unknown;
}

function readMetadata(metadataPath: string): DroidSessionMetadata {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    return metadata as DroidSessionMetadata;
  } catch {
    return {};
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string | Buffer) => {
  input += chunk.toString();
});
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input || "{}") as DroidHookEvent;
    const droidSessionId = typeof event.session_id === "string" ? event.session_id.trim() : "";
    if (!SESSION_ID_RE.test(droidSessionId)) return;

    const aoDataDir = process.env.AO_DATA_DIR;
    const aoSession = process.env.AO_SESSION || process.env.AO_SESSION_ID;
    if (!aoDataDir || !aoSession || !SESSION_ID_RE.test(aoSession)) return;

    const metadataPath = join(aoDataDir, aoSession + ".json");
    const metadata = readMetadata(metadataPath);
    metadata.droidSessionId = droidSessionId;
    if (typeof event.transcript_path === "string" && event.transcript_path.trim()) {
      metadata.droidTranscriptPath = event.transcript_path.trim();
    }

    mkdirSync(dirname(metadataPath), { recursive: true });
    const tmpPath = metadataPath + ".tmp-" + process.pid;
    writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + "\n");
    renameSync(tmpPath, metadataPath);
  } catch {
    // Best effort: metadata capture must never affect Droid startup or prompts.
  }
});
