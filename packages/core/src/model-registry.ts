/**
 * model-registry.ts — the SINGLE SOURCE OF TRUTH for model → provider → driver.
 *
 * Before this, "which provider runs this model" was decided by string-prefix
 * checks (`model.startsWith("glm-")` / `"mimo-"`) duplicated across three sites
 * (agent-claude-code getEnvironment, runtime-sdk create, the sdk-host dispatch).
 * That does not scale (GPT/OpenAI, Qwen, Grok, OpenRouter, local models all add
 * more prefixes) and drifts out of sync. This module centralizes the mapping.
 *
 * Two SEPARATE axes — do not collapse them:
 *   - provider:      billing / auth identity (anthropic | zhipu | mimo | openai)
 *   - runtimeDriver: the actual runtime path that streams the session
 *
 * They are NOT 1:1. The load-bearing example is MiMo: its provider is `mimo`
 * but its driver is `claude-agent-sdk` (we point the Claude Agent SDK at MiMo's
 * Anthropic-compatible endpoint to get the FULL agent path — tools + system
 * prompt + discipline hooks). Resolving MiMo to an "openai" driver would silently
 * downgrade it to the chat-loop fallback. Hence the descriptor carries both.
 *
 * RESOLUTION POLICY (registry-first, prefix-fallback): {@link resolveProvider}
 * looks the model up in the registry; an UNKNOWN model (the CLI accepts any
 * `--model` string) falls back to {@link inferProviderFromId}, which reproduces
 * the legacy prefix heuristic. So existing behavior is preserved exactly while
 * the registry becomes the authoritative path for known models.
 */

import type { GlobalConfig } from "./global-config.js";

/** Billing / auth identity of a model. */
export type ProviderId = "anthropic" | "zhipu" | "mimo" | "openai";

/**
 * The runtime path that actually streams a session. Distinct from {@link ProviderId}:
 *   - claude-agent-sdk  — @anthropic-ai/claude-agent-sdk query() (Claude native)
 *   - mimo-anthropic    — the SAME SDK pointed at MiMo's Anthropic-compatible
 *                         endpoint (full agent path for MiMo)
 *   - openai-compat     — OpenAI-compatible /chat/completions chat loop (GLM,
 *                         MiMo legacy fallback) — text only, no tools
 *   - openai-responses  — native OpenAI Responses API driver (added in a later
 *                         phase; text-only fallback)
 *   - codex-app-server  — OpenAI Codex app-server bridge (full coding agent path)
 */
export type RuntimeDriver =
  | "claude-agent-sdk"
  | "mimo-anthropic"
  | "openai-compat"
  | "openai-responses"
  | "codex-app-server";

/**
 * What a provider/model actually supports, so the UI never promises more than
 * the runtime delivers (e.g. GLM's chat-loop has no tools/approvals/resume).
 */
export interface ModelCapabilities {
  /** Token-level streaming of the assistant message. */
  streaming: boolean;
  /** Agentic tool use (Read/Edit/Bash/...) with a real tool loop. */
  tools: boolean;
  /** Interactive permission/approval prompts for tool calls. */
  approvals: boolean;
  /** Reasoning / thinking content is surfaced. */
  reasoning: boolean;
  /** Real token-usage accounting (not a zero stub). */
  usage: boolean;
  /** Conversation can be resumed as a provider session after host restart. */
  resume: boolean;
}

/** Where the credentials for a model's provider come from. */
export interface ModelAuth {
  /**
   * The GlobalConfig block holding this provider's creds, or null for Anthropic
   * (which authenticates from the ambient ANTHROPIC_API_KEY / login, not a config
   * block). Used by availability checks and the config→env bridge.
   */
  configKey: "zhipu" | "mimo" | "openai" | null;
  /**
   * The env var the sdk-host reads the provider API key from (AO_GLM_API_KEY /
   * AO_MIMO_API_KEY), or null when no API-key bridge is needed. OpenAI/GPT uses
   * Codex's own login cache for the `codex-app-server` driver.
   */
  envKey: string | null;
}

/** A single known model and everything the system needs to route + describe it. */
export interface ModelDescriptor {
  /** Canonical model id sent to the provider API (for Claude this is the alias — see module docs). */
  id: string;
  provider: ProviderId;
  /** DEFAULT runtime driver. Provider ≠ driver — see module docs (MiMo). */
  runtimeDriver: RuntimeDriver;
  /** Human-facing name shown in the model picker. */
  label: string;
  /** UI grouping header (mirrors the app's preset sections). */
  section: string;
  /** Extra UX aliases that resolve to this descriptor (lowercased on lookup). */
  aliases: string[];
  capabilities: ModelCapabilities;
  auth: ModelAuth;
  /** Hint for default selection by session role, if any. */
  defaultFor?: "orchestrator" | "worker" | "cheap-worker";
}

// ===========================================================================
// Capability presets — the three runtime tiers we have today.
// ===========================================================================

/** Claude / MiMo full-agent: everything on. */
const FULL_AGENT_CAPS: ModelCapabilities = {
  streaming: true,
  tools: true,
  approvals: true,
  reasoning: true,
  usage: true,
  resume: true,
};

/** OpenAI-compatible chat loop (GLM today): text streaming only. */
const CHAT_ONLY_CAPS: ModelCapabilities = {
  streaming: true,
  tools: false,
  approvals: false,
  reasoning: false,
  usage: false,
  resume: false,
};

/** OpenAI via Codex app-server: full local coding-agent behavior. */
const OPENAI_CODEX_CAPS: ModelCapabilities = {
  streaming: true,
  tools: true,
  approvals: true,
  reasoning: true,
  usage: true,
  resume: true,
};

// ===========================================================================
// The registry. Mirrors the app's hardcoded presets (ModelPresetsClient.swift)
// so `ao models list` can become the single source the app reads from.
// ===========================================================================

/**
 * Built-in model descriptors. Order is display order within each section.
 *
 * Claude ids are the SDK aliases (`opus`/`sonnet`/`haiku`) ON PURPOSE: the
 * Agent SDK resolves them to the concrete dated model itself (via
 * ANTHROPIC_DEFAULT_*_MODEL), so we pass them through unchanged. Rewriting them
 * to a pinned id here would fight that resolution.
 */
export const MODEL_REGISTRY: ModelDescriptor[] = [
  // --- Claude (anthropic → claude-agent-sdk) ---
  {
    id: "opus",
    provider: "anthropic",
    runtimeDriver: "claude-agent-sdk",
    label: "Claude Opus",
    section: "Claude",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: null, envKey: null },
    defaultFor: "orchestrator",
  },
  {
    id: "sonnet",
    provider: "anthropic",
    runtimeDriver: "claude-agent-sdk",
    label: "Claude Sonnet",
    section: "Claude",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: null, envKey: null },
  },
  {
    id: "haiku",
    provider: "anthropic",
    runtimeDriver: "claude-agent-sdk",
    label: "Claude Haiku",
    section: "Claude",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: null, envKey: null },
    defaultFor: "cheap-worker",
  },

  // --- ZhipuAI GLM (zhipu → openai-compat chat loop) ---
  ...(["glm-5.2", "glm-4.5-air", "glm-4.5", "glm-4.6", "glm-4.7"].map(
    (id): ModelDescriptor => ({
      id,
      provider: "zhipu",
      runtimeDriver: "openai-compat",
      label: id.replace(/^glm-/, "GLM-").replace("-air", " Air"),
      section: "ZhipuAI (GLM)",
      aliases: [],
      capabilities: CHAT_ONLY_CAPS,
      auth: { configKey: "zhipu", envKey: "AO_GLM_API_KEY" },
    }),
  )),

  // --- MiMo (mimo → claude-agent-sdk via Anthropic-compatible endpoint) ---
  // provider ≠ driver: full agent path, NOT the openai-compat fallback.
  {
    id: "mimo-v2.5-pro",
    provider: "mimo",
    runtimeDriver: "mimo-anthropic",
    label: "MiMo v2.5 Pro",
    section: "MiMo (Xiaomi)",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: "mimo", envKey: "AO_MIMO_API_KEY" },
  },
  {
    id: "mimo-v2.5",
    provider: "mimo",
    runtimeDriver: "mimo-anthropic",
    label: "MiMo v2.5",
    section: "MiMo (Xiaomi)",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: "mimo", envKey: "AO_MIMO_API_KEY" },
  },
  {
    id: "mimo-v2-pro",
    provider: "mimo",
    runtimeDriver: "mimo-anthropic",
    label: "MiMo v2 Pro",
    section: "MiMo (Xiaomi)",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: "mimo", envKey: "AO_MIMO_API_KEY" },
  },
  {
    id: "mimo-v2-flash",
    provider: "mimo",
    runtimeDriver: "mimo-anthropic",
    label: "MiMo v2 Flash",
    section: "MiMo (Xiaomi)",
    aliases: [],
    capabilities: FULL_AGENT_CAPS,
    auth: { configKey: "mimo", envKey: "AO_MIMO_API_KEY" },
  },

  // --- OpenAI (openai → codex-app-server full agent driver) ---
  // provider ≠ driver: a dedicated Codex app-server bridge, not the text-only
  // Responses chat loop. This is the path that gives GPT models local coding
  // tools, approvals, sandboxing, and resumable Codex threads.
  ...(["gpt-5.5", "gpt-5.1"].map(
    (id): ModelDescriptor => ({
      id,
      provider: "openai",
      runtimeDriver: "codex-app-server",
      label: id.replace(/^gpt-/, "GPT-"),
      section: "OpenAI",
      aliases: [],
      capabilities: OPENAI_CODEX_CAPS,
      auth: { configKey: "openai", envKey: null },
    }),
  )),
];

// ===========================================================================
// Lookup index (id + aliases, lowercased).
// ===========================================================================

const BY_KEY: Map<string, ModelDescriptor> = (() => {
  const m = new Map<string, ModelDescriptor>();
  for (const d of MODEL_REGISTRY) {
    m.set(d.id.toLowerCase(), d);
    for (const alias of d.aliases) m.set(alias.toLowerCase(), d);
  }
  return m;
})();

/** Resolve a model id or alias to its descriptor, or undefined if unknown. */
export function resolveModel(idOrAlias: string | null | undefined): ModelDescriptor | undefined {
  if (!idOrAlias) return undefined;
  return BY_KEY.get(idOrAlias.trim().toLowerCase());
}

/**
 * Legacy prefix heuristic — the FALLBACK for models not in the registry. Mirrors
 * exactly the historical `startsWith` dispatch so unknown `--model` strings route
 * the same as they always have. `gpt-*` / `o1`-`o4*` map to `openai`; the runtime
 * driver then maps OpenAI to the Codex app-server bridge.
 */
export function inferProviderFromId(modelId: string | null | undefined): ProviderId {
  const m = (modelId ?? "").trim().toLowerCase();
  if (m.startsWith("glm-")) return "zhipu";
  if (m.startsWith("mimo-")) return "mimo";
  if (m.startsWith("gpt-") || /^o[1-4]\b/.test(m) || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) {
    return "openai";
  }
  return "anthropic";
}

/**
 * Resolve the PROVIDER for a model. Registry-first, prefix-fallback. This is the
 * one function the three former prefix-dispatch sites now call, so they share a
 * single source of truth.
 */
export function resolveProvider(idOrAlias: string | null | undefined): ProviderId {
  return resolveModel(idOrAlias)?.provider ?? inferProviderFromId(idOrAlias);
}

/**
 * The credential coordinates for a PROVIDER (not a single model): the config
 * block holding its key and the env var the sdk-host reads it from. Derived from
 * the registry (the first descriptor of that provider) so it never drifts from
 * the per-model `auth`. Providers with no descriptor yet (openai) and the ambient
 * Anthropic provider get explicit fallbacks. Used by {@link resolveProviderKey}
 * (credential-store.ts) so the env→Keychain→YAML resolution keys off `provider`.
 */
export function providerAuth(provider: ProviderId): ModelAuth {
  const d = MODEL_REGISTRY.find((m) => m.provider === provider);
  if (d) return d.auth;
  // No descriptor in the registry yet — keep the conventional coordinates so the
  // resolver still works once a descriptor is added.
  switch (provider) {
    case "openai":
      return { configKey: "openai", envKey: null };
    // anthropic — authenticates ambiently (ANTHROPIC_API_KEY / login), no block.
    default:
      return { configKey: null, envKey: null };
  }
}

/**
 * Resolve the DEFAULT runtime driver for a model. For unknown models we map the
 * inferred provider to its conventional driver (anthropic→claude-agent-sdk,
 * openai→codex-app-server, zhipu→openai-compat, mimo→mimo-anthropic). Known
 * models use their descriptor's driver.
 */
export function resolveDriver(idOrAlias: string | null | undefined): RuntimeDriver {
  const known = resolveModel(idOrAlias);
  if (known) return known.runtimeDriver;
  switch (inferProviderFromId(idOrAlias)) {
    case "zhipu":
      return "openai-compat";
    case "mimo":
      return "mimo-anthropic";
    case "openai":
      return "codex-app-server";
    default:
      return "claude-agent-sdk";
  }
}

// ===========================================================================
// Availability (used by `ao models list` in a later phase).
// ===========================================================================

export interface ModelAvailability {
  available: boolean;
  /** Human-readable reason when unavailable (e.g. "ZhipuAI not enabled"). */
  reason?: string;
}

/**
 * Whether a model can actually be used given the current global config. Anthropic
 * models are always considered available (auth is ambient). Provider-keyed models
 * require their config block to be `enabled`; GLM/MiMo additionally require a
 * non-empty `apiKey` in the block (their keys may still live in YAML for
 * back-compat). OpenAI is gated on the Codex-auth `enabled` flag alone.
 */
export function modelAvailability(
  descriptor: ModelDescriptor,
  config: GlobalConfig | null | undefined,
): ModelAvailability {
  const key = descriptor.auth.configKey;
  if (!key) return { available: true };
  const block = (config as Record<string, unknown> | null | undefined)?.[key] as
    | { apiKey?: string; enabled?: boolean }
    | undefined;
  if (!block?.enabled) return { available: false, reason: `${descriptor.section} not enabled` };
  // OpenAI/GPT runs through Codex app-server. The actual credential lives in
  // Codex's login cache, while `openai.enabled` is the app-managed gate that says
  // the user completed Codex ChatGPT auth for Maestro's CODEX_HOME. Do not look
  // for an API key here; GPT is not an API-key settings provider anymore.
  if (key === "openai") return { available: true };
  if (!block.apiKey || block.apiKey.trim().length === 0) {
    return { available: false, reason: `${descriptor.section} API key missing` };
  }
  return { available: true };
}
