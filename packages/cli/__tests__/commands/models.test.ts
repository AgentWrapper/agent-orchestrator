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

  it("exposes Claude Fable 5 as an ambient, available full-agent Claude model", () => {
    const fable = entryById(buildModelsListPayload(null, {}).models, "claude-fable-5");
    expect(fable.displayName).toBe("Claude Fable 5");
    expect(fable.provider).toBe("anthropic");
    expect(fable.section).toBe("Claude");
    expect(fable.runtimeDriver).toBe("claude-agent-sdk");
    expect(fable.aliases).toContain("fable");
    expect(fable.auth.needsKey).toBe(false);
    expect(fable.available).toBe(true);
    expect(fable.capabilities.tools).toBe(true);
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

  it("reports OpenAI models as unconfigured + unavailable with no config", () => {
    const openai = buildModelsListPayload(null, {}).models.filter((m) => m.provider === "openai");
    expect(openai.length).toBeGreaterThan(0);
    for (const m of openai) {
      expect(m.auth.configured).toBe(false);
      expect(m.available).toBe(false);
    }
  });

  it("OpenAI becomes configured + available from the Codex-auth enabled flag", () => {
    // The app sets openai.enabled=true after Codex ChatGPT auth is ready for the
    // runtime CODEX_HOME. GPT is not an API-key settings provider.
    const config = { openai: { enabled: true } } as unknown as GlobalConfig;
    const gpt = entryById(buildModelsListPayload(config, {}).models, "gpt-5.5");
    expect(gpt.auth.needsKey).toBe(false);
    expect(gpt.auth.configured).toBe(true);
    expect(gpt.available).toBe(true);
    expect(gpt.reason).toBeUndefined();
    expect(gpt.runtimeDriver).toBe("codex-app-server");
    expect(gpt.capabilities.tools).toBe(true);
  });

  it("OpenAI disabled -> unconfigured + unavailable even if a stray apiKey sits in YAML", () => {
    const config = { openai: { enabled: false, apiKey: "k" } } as unknown as GlobalConfig;
    const gpt = entryById(buildModelsListPayload(config, {}).models, "gpt-5.5");
    // GPT ignores stale openai.apiKey values; only Codex-auth `enabled` matters.
    expect(gpt.auth.configured).toBe(false);
    expect(gpt.available).toBe(false);
    expect(gpt.reason).toBeTruthy();
  });
});
