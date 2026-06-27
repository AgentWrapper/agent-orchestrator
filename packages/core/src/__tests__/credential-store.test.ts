import { describe, expect, it, vi } from "vitest";

import {
  resolveProviderKey,
  readProviderKeychainSecret,
  PROVIDER_KEYCHAIN_SERVICE,
  type KeychainReader,
} from "../credential-store.js";
import type { GlobalConfig } from "../global-config.js";

/** Minimal GlobalConfig stub carrying only the provider blocks under test. */
function cfg(over: Partial<GlobalConfig> = {}): GlobalConfig {
  return over as GlobalConfig;
}

/** A Keychain reader that returns canned values per account, else null. */
function fakeKeychain(map: Record<string, string>): KeychainReader {
  return (account) => map[account] ?? null;
}

const NEVER_KEYCHAIN: KeychainReader = () => null;

describe("credential-store: resolveProviderKey precedence", () => {
  it("env wins over Keychain and YAML", () => {
    const key = resolveProviderKey(
      "zhipu",
      cfg({ zhipu: { apiKey: "yaml-key" } }),
      { AO_GLM_API_KEY: "env-key" },
      fakeKeychain({ zhipu: "keychain-key" }),
    );
    expect(key).toBe("env-key");
  });

  it("Keychain wins over YAML when env is absent", () => {
    const key = resolveProviderKey(
      "zhipu",
      cfg({ zhipu: { apiKey: "yaml-key" } }),
      {},
      fakeKeychain({ zhipu: "keychain-key" }),
    );
    expect(key).toBe("keychain-key");
  });

  it("falls back to YAML when env + Keychain are empty (old setup, no Keychain)", () => {
    const key = resolveProviderKey(
      "zhipu",
      cfg({ zhipu: { apiKey: "yaml-key" } }),
      {},
      NEVER_KEYCHAIN,
    );
    expect(key).toBe("yaml-key");
  });

  it("returns undefined when no source carries a value", () => {
    const key = resolveProviderKey("zhipu", cfg({}), {}, NEVER_KEYCHAIN);
    expect(key).toBeUndefined();
  });

  it("treats blank/whitespace values as absent and falls through", () => {
    const key = resolveProviderKey(
      "mimo",
      cfg({ mimo: { apiKey: "yaml-mimo" } }),
      { AO_MIMO_API_KEY: "   " },
      fakeKeychain({ mimo: "" }),
    );
    expect(key).toBe("yaml-mimo");
  });

  it("resolves MiMo from the AO_MIMO_API_KEY env var", () => {
    const key = resolveProviderKey("mimo", cfg({}), { AO_MIMO_API_KEY: "m" }, NEVER_KEYCHAIN);
    expect(key).toBe("m");
  });

  it("queries the Keychain by provider id as the account", () => {
    const reader = vi.fn<KeychainReader>(() => "kc");
    resolveProviderKey("mimo", cfg({}), {}, reader);
    expect(reader).toHaveBeenCalledWith("mimo");
  });

  it("never touches the Keychain when env already provides the key", () => {
    const reader = vi.fn<KeychainReader>(() => "kc");
    const key = resolveProviderKey("zhipu", cfg({}), { AO_GLM_API_KEY: "e" }, reader);
    expect(key).toBe("e");
    expect(reader).not.toHaveBeenCalled();
  });

  it("anthropic needs no key — undefined, Keychain never consulted", () => {
    const reader = vi.fn<KeychainReader>(() => "kc");
    const key = resolveProviderKey("anthropic", cfg({}), {}, reader);
    expect(key).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("credential-store: readProviderKeychainSecret (real reader)", () => {
  it("returns null off macOS without throwing or prompting", () => {
    if (process.platform === "darwin") {
      // On macOS, a never-written item must resolve to null (errSecItemNotFound),
      // never a thrown error or a hang.
      expect(readProviderKeychainSecret("definitely-not-a-real-provider-xyz")).toBeNull();
    } else {
      expect(readProviderKeychainSecret("zhipu")).toBeNull();
    }
  });

  it("exposes the shared service name for the Swift app contract", () => {
    expect(PROVIDER_KEYCHAIN_SERVICE).toBe("Maestro-provider-keys");
  });
});
