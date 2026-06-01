import "server-only";

import { type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import {
  isLinux,
  isMac,
  isWindows,
  createDefaultGlobalConfig,
  getGlobalConfigPath,
  killProcessTree,
  loadGlobalConfig,
  saveGlobalConfig,
  spawnManagedDaemonChild,
  type GlobalConfig,
} from "@aoagents/ao-core";

interface RemoteHost {
  url: string;
  ip: string;
  port: number;
}

export interface RemoteAccessInfo {
  enabled: boolean;
  authRequired: boolean;
  username: string;
  password?: string;
  hosts: RemoteHost[];
}

let tunnelProcess: ChildProcess | null = null;
let enableRemoteAccessPromise: Promise<RemoteAccessInfo> | null = null;

type RemoteAccessConfig = {
  username?: string;
  password?: string;
};

function loadGlobalConfigOrDefault(): GlobalConfig {
  return loadGlobalConfig(getGlobalConfigPath()) ?? createDefaultGlobalConfig();
}

function remoteAccessConfig(config: GlobalConfig): RemoteAccessConfig {
  return config.remoteAccess && typeof config.remoteAccess === "object" ? config.remoteAccess : {};
}

function configuredUsername(config = loadGlobalConfigOrDefault()): string {
  return remoteAccessConfig(config).username?.trim() || process.env["AO_REMOTE_AUTH_USER"] || "ao";
}

function configuredPassword(config = loadGlobalConfigOrDefault()): string | undefined {
  const password =
    remoteAccessConfig(config).password?.trim() || process.env["AO_REMOTE_AUTH_PASSWORD"];
  return password && password.length > 0 ? password : undefined;
}

function applyRemoteCredentials(username: string, password: string): void {
  process.env["AO_REMOTE_AUTH_USER"] = username;
  process.env["AO_REMOTE_AUTH_PASSWORD"] = password;
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

function tryCloudflareUrl(line: string): string | null {
  return line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}

function getCloudflaredCachePath(): string {
  return resolve(
    homedir(),
    ".agent-orchestrator",
    "bin",
    isWindows() ? "cloudflared.exe" : "cloudflared",
  );
}

function getCloudflaredDownload(): { url: string; archive: boolean } {
  const arch = process.arch;
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";

  if (isMac()) {
    if (arch === "arm64") return { url: `${base}/cloudflared-darwin-arm64.tgz`, archive: true };
    if (arch === "x64") return { url: `${base}/cloudflared-darwin-amd64.tgz`, archive: true };
  }
  if (isLinux()) {
    if (arch === "arm64") return { url: `${base}/cloudflared-linux-arm64`, archive: false };
    if (arch === "x64") return { url: `${base}/cloudflared-linux-amd64`, archive: false };
    if (arch === "arm") return { url: `${base}/cloudflared-linux-arm`, archive: false };
    if (arch === "ia32") return { url: `${base}/cloudflared-linux-386`, archive: false };
  }
  if (isWindows()) {
    if (arch === "ia32") return { url: `${base}/cloudflared-windows-386.exe`, archive: false };
    if (arch === "x64" || arch === "arm64") {
      return { url: `${base}/cloudflared-windows-amd64.exe`, archive: false };
    }
  }

  throw new Error(`Unsupported platform for automatic remote access: ${process.platform}/${arch}`);
}

async function fetchExpectedCloudflaredChecksum(assetName: string): Promise<string> {
  const response = await fetch(
    "https://api.github.com/repos/cloudflare/cloudflared/releases/latest",
    {
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) throw new Error(`Failed to fetch cloudflared checksums (${response.status})`);

  const release = (await response.json()) as { body?: unknown };
  const body = typeof release.body === "string" ? release.body : "";
  const escapedAssetName = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedAssetName}:\\s*([a-fA-F0-9]{64})`, "m").exec(body);
  if (!match?.[1]) throw new Error(`Missing SHA-256 checksum for ${assetName}`);
  return match[1].toLowerCase();
}

async function verifyCloudflaredDownload(assetName: string, bytes: Buffer): Promise<void> {
  const expected = await fetchExpectedCloudflaredChecksum(assetName);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`cloudflared checksum mismatch for ${assetName}`);
  }
}

async function downloadCloudflaredBinary(targetPath: string): Promise<void> {
  const { url, archive } = getCloudflaredDownload();
  const assetName = basename(new URL(url).pathname);
  const targetDir = dirname(targetPath);
  mkdirSync(targetDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download cloudflared (${response.status})`);
  const downloadBytes = Buffer.from(await response.arrayBuffer());
  await verifyCloudflaredDownload(assetName, downloadBytes);

  const tempDir = mkdtempSync(resolve(tmpdir(), "ao-cloudflared-"));
  try {
    if (archive) {
      const archivePath = resolve(tempDir, "cloudflared.tgz");
      writeFileSync(archivePath, downloadBytes);
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-xzf", archivePath, "-C", tempDir]);
      const extractedPath = resolve(tempDir, "cloudflared");
      if (!existsSync(extractedPath))
        throw new Error("cloudflared archive did not contain a binary");
      chmodSync(extractedPath, 0o755);
      renameSync(extractedPath, targetPath);
      return;
    }

    const tempPath = resolve(tempDir, basename(targetPath));
    writeFileSync(tempPath, downloadBytes);
    if (!isWindows()) chmodSync(tempPath, 0o755);
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function resolveCloudflaredBinary(): Promise<string> {
  const cachedPath = getCloudflaredCachePath();
  if (!existsSync(cachedPath)) await downloadCloudflaredBinary(cachedPath);
  return cachedPath;
}

function hostsFromEnv(): RemoteHost[] {
  const publicUrl = process.env["AO_REMOTE_PUBLIC_URL"];
  if (publicUrl) {
    return [{ url: publicUrl, ip: new URL(publicUrl).hostname, port: 443 }];
  }
  return [];
}

export function getRemoteAccessInfo(): RemoteAccessInfo {
  const hosts = hostsFromEnv();
  const username = configuredUsername();
  const password = configuredPassword();
  return {
    enabled: hosts.length > 0,
    authRequired: hosts.length > 0 && Boolean(password),
    username,
    password,
    hosts,
  };
}

export function saveRemoteAccessCredentials(input: {
  username?: unknown;
  password?: unknown;
}): RemoteAccessInfo {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password.trim() : "";
  if (!username) throw new Error("Remote username is required.");
  if (!password) throw new Error("Remote password is required.");

  const config = loadGlobalConfigOrDefault();
  const nextConfig: GlobalConfig = {
    ...config,
    remoteAccess: {
      ...remoteAccessConfig(config),
      username,
      password,
    },
  };
  saveGlobalConfig(nextConfig, getGlobalConfigPath());
  applyRemoteCredentials(username, password);
  return getRemoteAccessInfo();
}

async function startCloudflareTunnel(
  port: string,
): Promise<{ publicUrl: string; child: ChildProcess }> {
  const cloudflared = await resolveCloudflaredBinary();
  const child = spawnManagedDaemonChild(
    "remote-tunnel",
    cloudflared,
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"], detached: !isWindows() },
  );

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    let recentOutput = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `Timed out waiting for cloudflared.${recentOutput ? ` Last output: ${recentOutput.trim()}` : ""}`,
        ),
      );
    }, 30_000);

    function settle(publicUrl: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ publicUrl, child });
    }

    function append(data: Buffer) {
      const text = data.toString();
      recentOutput = `${recentOutput}${text}`.slice(-1000);
      const publicUrl = tryCloudflareUrl(text);
      if (publicUrl) settle(publicUrl);
    }

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `cloudflared exited before creating a tunnel${code === null ? "" : ` (${code})`}`,
        ),
      );
    });
  });
}

export async function enableRemoteAccess(): Promise<RemoteAccessInfo> {
  if (enableRemoteAccessPromise) return enableRemoteAccessPromise;

  const existing = getRemoteAccessInfo();
  if (existing.enabled) {
    return { ...existing, password: process.env["AO_REMOTE_AUTH_PASSWORD"] };
  }

  enableRemoteAccessPromise = (async () => {
    const config = loadGlobalConfigOrDefault();
    const password = configuredPassword(config) || generatePassword();
    applyRemoteCredentials(configuredUsername(config), password);

    const tunnel = await startCloudflareTunnel(process.env["PORT"] || "3000");
    tunnelProcess = tunnel.child;
    process.env["AO_REMOTE_PUBLIC_URL"] = tunnel.publicUrl;
    process.env["AO_REMOTE_TUNNEL_PID"] = tunnel.child.pid ? String(tunnel.child.pid) : "";

    return { ...getRemoteAccessInfo(), password };
  })();

  try {
    return await enableRemoteAccessPromise;
  } finally {
    enableRemoteAccessPromise = null;
  }
}

export async function disableRemoteAccess(): Promise<RemoteAccessInfo> {
  const pid = Number.parseInt(process.env["AO_REMOTE_TUNNEL_PID"] ?? "", 10);
  if (tunnelProcess?.pid) {
    await killProcessTree(tunnelProcess.pid, "SIGTERM");
  } else if (Number.isInteger(pid) && pid > 0) {
    await killProcessTree(pid, "SIGTERM");
  }
  tunnelProcess = null;
  delete process.env["AO_REMOTE_PUBLIC_URL"];
  delete process.env["AO_REMOTE_TUNNEL_PID"];
  return getRemoteAccessInfo();
}
