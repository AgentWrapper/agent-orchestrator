import { describe, expect, it } from "vitest";
import {
  MODEL_REGISTRY,
  inferProviderFromId,
  modelAvailability,
  resolveDriver,
  resolveModel,
  resolveProvider,
  type ModelDescriptor,
} from "../model-registry.js";

describe("model-registry: resolveModel", () => {
  it("resolves known Claude aliases (case-insensitive)", () => {
    expect(resolveModel("opus")?.provider).toBe("anthropic");
    expect(resolveModel("OPUS")?.id).toBe("opus");
    expect(resolveModel("sonnet")?.label).toBe("Claude Sonnet");
    expect(resolveModel("haiku")?.provider).toBe("anthropic");
  });

  it("resolves GLM + MiMo ids", () => {
    expect(resolveModel("glm-4.6")?.provider).toBe("zhipu");
    expect(resolveModel("mimo-v2.5")?.provider).toBe("mimo");
    expect(resolveModel("mimo-v2.5-pro")?.label).toBe("MiMo v2.5 Pro");
  });

  it("resolves the registered OpenAI ids", () => {
    expect(resolveModel("gpt-5.5")?.provider).toBe("openai");
    expect(resolveModel("gpt-5.1")?.runtimeDriver).toBe("codex-app-server");
    expect(resolveModel("GPT-5.5")?.label).toBe("GPT-5.5");
  });

  it("returns undefined for unknown / empty ids", () => {
    expect(resolveModel("gpt-4o")).toBeUndefined(); // unregistered OpenAI id
    expect(resolveModel("claude-opus-4-8")).toBeUndefined();
    expect(resolveModel("")).toBeUndefined();
    expect(resolveModel(null)).toBeUndefined();
    expect(resolveModel(undefined)).toBeUndefined();
  });
});

describe("model-registry: resolveProvider (behavior-preserving)", () => {
  // The legacy dispatch (the three former startsWith sites) decided provider as:
  //   model.startsWith("glm-")  -> GLM path
  //   model.startsWith("mimo-") -> MiMo path
  //   else                      -> Claude path
  // resolveProvider MUST reproduce that for every current model + reasonable
  // fallbacks. This is the "did not break it" guard for Phase 1.
  const legacyProvider = (m: string): string => {
    if (m.startsWith("glm-")) return "zhipu";
    if (m.startsWith("mimo-")) return "mimo";
    return "anthropic"; // legacy else-branch routed everything else to Claude
  };

  for (const m of [
    "opus",
    "sonnet",
    "haiku",
    "glm-5.2",
    "glm-4.5-air",
    "glm-4.5",
    "glm-4.6",
    "glm-4.7",
    "mimo-v2.5-pro",
    "mimo-v2.5",
    "mimo-v2-pro",
    "mimo-v2-flash",
    "claude-opus-4-8", // unknown full id -> anthropic fallback
    "some-random-model",
  ]) {
    it(`routes "${m}" the same as the legacy prefix dispatch`, () => {
      expect(resolveProvider(m)).toBe(legacyProvider(m));
    });
  }

  it("forward-maps gpt-* / o-series to openai (new fallback tier)", () => {
    expect(resolveProvider("gpt-5.5")).toBe("openai");
    expect(resolveProvider("gpt-4o")).toBe("openai");
    expect(resolveProvider("o1-preview")).toBe("openai");
    expect(resolveProvider("o3-mini")).toBe("openai");
  });

  it("defaults null/empty to anthropic", () => {
    expect(resolveProvider(null)).toBe("anthropic");
    expect(resolveProvider("")).toBe("anthropic");
  });
});

describe("model-registry: inferProviderFromId mirrors legacy prefixes", () => {
  it("glm- -> zhipu, mimo- -> mimo, else -> anthropic", () => {
    expect(inferProviderFromId("glm-anything")).toBe("zhipu");
    expect(inferProviderFromId("mimo-anything")).toBe("mimo");
    expect(inferProviderFromId("whatever")).toBe("anthropic");
  });
});

describe("model-registry: resolveDriver (provider ≠ driver)", () => {
  it("MiMo resolves to the claude-agent-sdk (anthropic endpoint) driver, NOT openai-compat", () => {
    // The load-bearing guard: MiMo must keep the full-agent path. A regression
    // to openai-compat would silently strip tools/approvals/resume.
    expect(resolveDriver("mimo-v2.5")).toBe("mimo-anthropic");
    expect(resolveDriver("mimo-v2-flash")).toBe("mimo-anthropic");
  });

  it("Claude -> claude-agent-sdk, GLM -> openai-compat", () => {
    expect(resolveDriver("opus")).toBe("claude-agent-sdk");
    expect(resolveDriver("glm-4.6")).toBe("openai-compat");
  });

  it("registered OpenAI models resolve to the Codex app-server full-agent driver", () => {
    expect(resolveDriver("gpt-5.5")).toBe("codex-app-server");
    expect(resolveDriver("gpt-5.1")).toBe("codex-app-server");
  });

  it("unknown models map provider -> conventional driver", () => {
    expect(resolveDriver("glm-future")).toBe("openai-compat"); // zhipu prefix
    expect(resolveDriver("mimo-future")).toBe("mimo-anthropic"); // mimo prefix
    expect(resolveDriver("gpt-4o")).toBe("codex-app-server");
    expect(resolveDriver("claude-opus-4-8")).toBe("claude-agent-sdk");
  });
});

describe("model-registry: modelAvailability", () => {
  const find = (id: string): ModelDescriptor => {
    const d = resolveModel(id);
    if (!d) throw new Error(`missing descriptor ${id}`);
    return d;
  };

  it("Anthropic models are always available (ambient auth)", () => {
    expect(modelAvailability(find("opus"), null).available).toBe(true);
    expect(modelAvailability(find("sonnet"), {} as never).available).toBe(true);
  });

  it("GLM requires zhipu enabled + non-empty apiKey", () => {
    const glm = find("glm-4.6");
    expect(modelAvailability(glm, null).available).toBe(false);
    expect(modelAvailability(glm, { zhipu: { enabled: false, apiKey: "x" } } as never).available).toBe(false);
    expect(modelAvailability(glm, { zhipu: { enabled: true, apiKey: "" } } as never).available).toBe(false);
    expect(modelAvailability(glm, { zhipu: { enabled: true, apiKey: "k" } } as never).available).toBe(true);
  });

  it("MiMo requires mimo enabled + non-empty apiKey", () => {
    const mimo = find("mimo-v2.5");
    expect(modelAvailability(mimo, { mimo: { enabled: true } } as never).available).toBe(false);
    expect(modelAvailability(mimo, { mimo: { enabled: true, apiKey: "k" } } as never).available).toBe(true);
  });

  it("OpenAI is gated on the enabled flag ALONE (key lives in the Keychain, not YAML)", () => {
    const gpt = find("gpt-5.5");
    // No config / disabled → unavailable.
    expect(modelAvailability(gpt, null).available).toBe(false);
    expect(modelAvailability(gpt, { openai: { enabled: false } } as never).available).toBe(false);
    expect(modelAvailability(gpt, { openai: { enabled: false, apiKey: "k" } } as never).available).toBe(false);
    // enabled === true is sufficient — NO apiKey in the YAML block is required
    // (the app writes the key to the Keychain and sets enabled ⇒ key present).
    expect(modelAvailability(gpt, { openai: { enabled: true } } as never).available).toBe(true);
    expect(modelAvailability(gpt, { openai: { enabled: true, apiKey: "" } } as never).available).toBe(true);
    expect(modelAvailability(gpt, { openai: { enabled: true, apiKey: "k" } } as never).available).toBe(true);
    expect(modelAvailability(gpt, { openai: { enabled: false } } as never).reason).toMatch(/OpenAI/);
  });

  it("gives a human-readable reason when unavailable", () => {
    const glm = find("glm-4.6");
    expect(modelAvailability(glm, null).reason).toMatch(/GLM/);
  });
});

describe("model-registry: integrity", () => {
  it("MiMo descriptors all use the mimo-anthropic driver (provider ≠ driver invariant)", () => {
    for (const d of MODEL_REGISTRY.filter((m) => m.provider === "mimo")) {
      expect(d.runtimeDriver).toBe("mimo-anthropic");
    }
  });

  it("provider-keyed models carry auth config + env keys; Anthropic carries none", () => {
    for (const d of MODEL_REGISTRY) {
      if (d.provider === "anthropic") {
        expect(d.auth.configKey).toBeNull();
        expect(d.auth.envKey).toBeNull();
      } else {
        expect(d.auth.configKey).not.toBeNull();
        expect(d.auth.envKey).not.toBeNull();
      }
    }
  });

  it("every id resolves back to itself (lookup index is complete)", () => {
    for (const d of MODEL_REGISTRY) {
      expect(resolveModel(d.id)?.id).toBe(d.id);
    }
  });

  it("GLM capabilities are chat-only (no tools/approvals/resume)", () => {
    const glm = resolveModel("glm-4.6")!;
    expect(glm.capabilities.tools).toBe(false);
    expect(glm.capabilities.approvals).toBe(false);
    expect(glm.capabilities.resume).toBe(false);
    expect(glm.capabilities.streaming).toBe(true);
  });

  it("Claude + MiMo capabilities are full-agent", () => {
    for (const id of ["opus", "mimo-v2.5"]) {
      const caps = resolveModel(id)!.capabilities;
      expect(caps.tools).toBe(true);
      expect(caps.approvals).toBe(true);
      expect(caps.resume).toBe(true);
    }
  });

  it("OpenAI capabilities are full-agent through Codex app-server", () => {
    for (const id of ["gpt-5.5", "gpt-5.1"]) {
      const caps = resolveModel(id)!.capabilities;
      expect(caps.streaming).toBe(true);
      expect(caps.usage).toBe(true);
      expect(caps.tools).toBe(true);
      expect(caps.approvals).toBe(true);
      expect(caps.resume).toBe(true);
    }
    // All OpenAI descriptors use the Codex app-server bridge (provider ≠ driver).
    for (const d of MODEL_REGISTRY.filter((m) => m.provider === "openai")) {
      expect(d.runtimeDriver).toBe("codex-app-server");
      expect(d.section).toBe("OpenAI");
    }
  });
});
