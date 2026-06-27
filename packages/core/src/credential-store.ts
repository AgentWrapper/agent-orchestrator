/**
 * credential-store.ts — resolve a provider's API key from the most secure source
 * available, with a strictly ADDITIVE migration path off plaintext config.yaml.
 *
 * Until now, GLM (zhipu) and MiMo keys lived ONLY in plaintext under
 * `~/.agent-orchestrator/config.yaml` (`zhipu.apiKey` / `mimo.apiKey`). The
 * Maestro app now stores them in the macOS Keychain instead (namespace
 * `Maestro-provider-keys`, one item per provider id). This module lets the
 * cross-platform Node engine pick up that Keychain value while keeping every
 * existing YAML setup working untouched.
 *
 * RESOLUTION ORDER (first non-empty wins):
 *   1. env  AO_*_API_KEY     — explicit per-session / per-process override.
 *   2. Keychain              — macOS only; what the app writes today.
 *   3. config.yaml block     — back-compat for setups predating the Keychain.
 *
 * ZERO-LOCKOUT GUARANTEES:
 *   - The Keychain read is best-effort: macOS-only, time-bounded, and any
 *     failure (not macOS, item absent, ACL denial, GUI prompt killed by the
 *     timeout) yields `null` and falls through to the YAML block. An old
 *     YAML-only install therefore keeps resolving its key with no behaviour
 *     change and no Keychain prompt (a missing item returns errSecItemNotFound,
 *     never a dialog).
 *   - In the live Maestro flow the daemon is spawned by the app WITH the key
 *     already in its environment (AOEngineClient reads it and exports
 *     AO_GLM_API_KEY / AO_MIMO_API_KEY), so step 1 short-circuits and the engine
 *     never touches the Keychain — no cross-identity ACL prompt can occur. The
 *     Keychain read is reached only by a standalone `ao` started outside the app.
 */

import { spawnSync } from "node:child_process";

import type { GlobalConfig } from "./global-config.js";
import { providerAuth, type ProviderId } from "./model-registry.js";

/**
 * Keychain service name shared with the Maestro app (see ProviderKeychain.swift).
 * One generic-password item per provider: service = this constant, account =
 * provider id (`zhipu` / `mimo`).
 */
export const PROVIDER_KEYCHAIN_SERVICE = "Maestro-provider-keys";

/** Time budget for the `security` shell-out. A GUI auth dialog (non-owner read)
 *  is killed when this elapses so a standalone daemon can never hang on it. */
const KEYCHAIN_READ_TIMEOUT_MS = 2000;

/**
 * Read a provider key from the macOS login Keychain via the canonical
 * `security find-generic-password -s <service> -a <account> -w`. Returns the
 * trimmed secret, or `null` for ANY reason it can't be read silently: not macOS,
 * item absent, non-zero exit, timeout, or spawn failure. Never throws, never
 * blocks beyond {@link KEYCHAIN_READ_TIMEOUT_MS}.
 */
export function readProviderKeychainSecret(account: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const res = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", PROVIDER_KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf8", timeout: KEYCHAIN_READ_TIMEOUT_MS },
    );
    if (res.error || res.status !== 0) return null;
    const value = (res.stdout ?? "").replace(/\r?\n$/, "");
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Injectable Keychain reader so the resolver is unit-testable without macOS. */
export type KeychainReader = (account: string) => string | null;

/**
 * Resolve a provider's API key: env → Keychain → config.yaml. Returns `undefined`
 * when no source carries a non-empty value, and for providers that need no key
 * (Anthropic authenticates ambiently — `configKey === null`).
 *
 * @param provider     the billing/auth provider (zhipu / mimo / …).
 * @param config       loaded GlobalConfig (or null) — the YAML fallback source.
 * @param env          the process env to read AO_*_API_KEY from.
 * @param readKeychain injectable Keychain reader (defaults to the real one).
 */
export function resolveProviderKey(
  provider: ProviderId,
  config: GlobalConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readKeychain: KeychainReader = readProviderKeychainSecret,
): string | undefined {
  const { configKey, envKey } = providerAuth(provider);

  // 1) Explicit env override (AO_GLM_API_KEY / AO_MIMO_API_KEY / …).
  if (envKey) {
    const fromEnv = env[envKey];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  }

  // Anthropic & friends authenticate ambiently — nothing more to resolve.
  if (!configKey) return undefined;

  // 2) macOS Keychain (best-effort; never throws). account = provider id.
  const fromKeychain = readKeychain(provider);
  if (fromKeychain && fromKeychain.trim().length > 0) return fromKeychain;

  // 3) config.yaml block (back-compat — still written by the app for now).
  const block = (config as Record<string, unknown> | null | undefined)?.[configKey] as
    | { apiKey?: string }
    | undefined;
  const fromYaml = block?.apiKey;
  if (fromYaml && fromYaml.trim().length > 0) return fromYaml;

  return undefined;
}
