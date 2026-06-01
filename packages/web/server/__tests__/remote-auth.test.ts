import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRemoteAuthCredentials } from "../remote-auth.js";

const originalRemoteUser = process.env.AO_REMOTE_AUTH_USER;
const originalRemotePassword = process.env.AO_REMOTE_AUTH_PASSWORD;

function tempConfigPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ao-remote-auth-"));
  return { dir, path: join(dir, "config.yaml") };
}

describe("remote auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalRemoteUser === undefined) delete process.env.AO_REMOTE_AUTH_USER;
    else process.env.AO_REMOTE_AUTH_USER = originalRemoteUser;
    if (originalRemotePassword === undefined) delete process.env.AO_REMOTE_AUTH_PASSWORD;
    else process.env.AO_REMOTE_AUTH_PASSWORD = originalRemotePassword;
  });

  it("persists generated credentials at startup so middleware has an auth password", () => {
    const { dir, path } = tempConfigPath();
    vi.stubEnv("AO_GLOBAL_CONFIG", path);
    vi.stubEnv("AO_REMOTE_AUTH_USER", "");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "");

    try {
      const credentials = ensureRemoteAuthCredentials();

      expect(credentials.username).toBe("ao");
      expect(credentials.password).toHaveLength(24);
      expect(process.env.AO_REMOTE_AUTH_USER).toBe("ao");
      expect(process.env.AO_REMOTE_AUTH_PASSWORD).toBe(credentials.password);
      expect(readFileSync(path, "utf8")).toContain(`password: ${credentials.password}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses saved credentials instead of replacing them", () => {
    const { dir, path } = tempConfigPath();
    writeFileSync(path, "remoteAccess:\n  username: saved\n  password: saved-password\n");
    vi.stubEnv("AO_GLOBAL_CONFIG", path);
    vi.stubEnv("AO_REMOTE_AUTH_USER", "env");
    vi.stubEnv("AO_REMOTE_AUTH_PASSWORD", "env-password");

    try {
      const credentials = ensureRemoteAuthCredentials();

      expect(credentials).toEqual({ username: "saved", password: "saved-password" });
      expect(process.env.AO_REMOTE_AUTH_USER).toBe("saved");
      expect(process.env.AO_REMOTE_AUTH_PASSWORD).toBe("saved-password");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
