import { describe, expect, it } from "vitest";
import type { GlobalConfig } from "@aoagents/ao-core";
import { MODEL_REGISTRY } from "@aoagents/ao-core";
import {
  buildModelsListPayload,
  MODELS_LIST_SCHEMA_VERSION,
  type ModelListEntry,
} from "../../src/commands/models.js";
import { createProgram } from "../../src/program.js";

function entryById(models: ModelListEntry[], id: string): ModelListEntry {
  const found = models.find((m) => m.id === id);
  if (!found) throw new Error(`model ${id} not in payload`);
  return found;
}

describe("ao models list", () => {
  it("is registered with a `list` subcommand", () => {
    const models = createProgram().commands.find((c) => c.name() === "models");
    expect(models?.commands.some((c) => c.name() === "list")).toBe(true);
  });

  it("emits a versioned envelope covering every registry model", () => {
    const payload = buildModelsListPayload(null, {});
    expect(payload.schemaVersion).toBe(MODELS_LIST_SCHEMA_VERSION);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.models).toHaveLength(MODEL_REGISTRY.length);
    expect(payload.models.map((m) => m.id).sort()).toEqual(
      MODEL_REGISTRY.map((d) => d.id).sort(),
    );
  });

  it("freezes the per-model field contract", () => {
    const payload = buildModelsListPayload(null, {});
    for (const m of payload.models) {
      expect(typeof m.id).toBe("string");
      expect(typeof m.displayName).toBe("string");
      expect(typeof m.provider).toBe("string");
      expect(typeof m.runtimeDriver).toBe("string");
      expect(typeof m.section).toBe("string");
      expect(Array.isArray(m.aliases)).toBe(true);
      expect(typeof m.available).toBe("boolean");
      // capabilities — all six flags present and boolean
      for (const k of [
        "streaming",
        "tools",
        "approvals",
        "reasoning",
        "usage",
        "resume",
      ] as const) {
        expect(typeof m.capabilities[k]).toBe("boolean");
      }
      // auth — needsKey + configured
      expect(typeof m.auth.needsKey).toBe("boolean");
      expect(typeof m.auth.configured).toBe("boolean");
    }
  });

  it("treats Anthropic as ambiently authenticated and available", () => {
    const opus = entryById(buildModelsListPayload(null, {}).models, "opus");
    expect(opus.provider).toBe("anthropic");
    expect(opus.auth.needsKey).toBe(false);
    expect(opus.auth.configured).toBe(true);
    expect(opus.available).toBe(true);
  });

  it("marks keyed providers unconfigured + unavailable with no config or env", () => {
    const glm = entryById(buildModelsListPayload(null, {}).models, "glm-5.2");
    expect(glm.auth.needsKey).toBe(true);
    expect(glm.auth.configured).toBe(false);
    expect(glm.available).toBe(false);
    expect(glm.reason).toBeTruthy();
  });

  it("treats a key as configured when present in the env (dispatch parity)", () => {
    const glm = entryById(
      buildModelsListPayload(null, { AO_GLM_API_KEY: "sk-test" }).models,
      "glm-5.2",
    );
    expect(glm.auth.configured).toBe(true);
    // env key alone does not flip availability — that still needs enabled+apiKey
    expect(glm.available).toBe(false);
  });

  it("becomes configured + available when the config block is enabled with a key", () => {
    const config = { mimo: { enabled: true, apiKey: "mimo-key" } } as unknown as GlobalConfig;
    const mimo = entryById(buildModelsListPayload(config, {}).models, "mimo-v2.5");
    expect(mimo.auth.configured).toBe(true);
    expect(mimo.available).toBe(true);
    expect(mimo.reason).toBeUndefined();
  });

  it("reports OpenAI models as unconfigured (no config block yet)", () => {
    const openai = buildModelsListPayload(null, {}).models.filter((m) => m.provider === "openai");
    for (const m of openai) {
      expect(m.auth.configured).toBe(false);
    }
  });
});
