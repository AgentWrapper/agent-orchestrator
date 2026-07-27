import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function activationProfileDigest(profile) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(profile)))
    .digest("hex");
}

export function createRuntimeJournal({ directory, runId, controllerId }) {
  const ownerPath = path.join(directory, "fake-runtime-owner");
  closeSync(openSync(ownerPath, "wx", 0o600));
  const journalPath = path.join(directory, "fake-runtime-journal.jsonl");

  async function read() {
    try {
      return (await readFile(journalPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function append(event) {
    const record = { ...event, runId, controllerId };
    await appendFile(journalPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return record;
  }

  return {
    read,
    append,
    async mutate(operation) {
      return operation({ read, append });
    },
  };
}

export function createCandidateRunKernel({
  mode,
  prepared,
  activationProfile,
  controllerId,
  controllerInstanceId,
  journal,
}) {
  if (mode !== "observer") throw new Error("test kernel requires observer mode");
  if (activationProfile.schemaVersion !== 2) {
    throw new Error("test kernel requires activation profile schema v2");
  }
  if (
    typeof activationProfile.adapterArtifact !== "string" ||
    activationProfile.adapterArtifact.trim() === "" ||
    typeof activationProfile.modelProvider !== "string" ||
    activationProfile.modelProvider.trim() === ""
  ) {
    throw new Error(
      "test kernel requires schema-v2 adapter artifact and model provider",
    );
  }
  if (prepared.controllerOwner !== controllerId) {
    throw new Error("test kernel controller mismatch");
  }
  if (
    prepared.activationProfileDigest !==
    activationProfileDigest(activationProfile)
  ) {
    throw new Error("test kernel activation profile digest drifted");
  }
  prepared.tasks.forEach((task, schedulingOrder) => {
    if (task.schedulingOrder !== schedulingOrder) {
      throw new Error("test kernel scheduling order drifted");
    }
  });

  return {
    configure(request) {
      return journal.append({
        eventId: request.eventId,
        type: "run-configured",
        slot: null,
        at: request.at,
        payload: {
          mode,
          controllerClaim: {
            claimId: request.claimId,
            controllerInstanceId,
          },
        },
      });
    },
    async observe(event) {
      const task = prepared.tasks.find(({ slot }) => slot === event.slot);
      if (!task) throw new Error("test kernel unknown task");
      if (
        event.type === "task-claimed" &&
        event.payload.controllerInstanceId !== controllerInstanceId
      ) {
        throw new Error("test kernel controller instance mismatch");
      }
      if (
        event.type === "pull-request-opened" &&
        (event.payload.repository !== prepared.repository ||
          event.payload.issueNumber !== task.issueNumber ||
          event.payload.branch !== task.branch)
      ) {
        throw new Error("test kernel off-target pull request");
      }
      return journal.append(event);
    },
    start() {
      throw new Error("test kernel start must not be called");
    },
    resume() {
      throw new Error("test kernel resume must not be called");
    },
    stop() {
      throw new Error("test kernel stop must not be called");
    },
  };
}
