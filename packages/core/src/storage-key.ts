import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";

export interface StorageKeyInput {
  originUrl: string | null;
  gitRoot: string;
  projectPath: string;
}

export function normalizeOriginUrl(raw: string): string {
  const trimmed = raw.trim();
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);

  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const path = stripTrailingGit(stripSlashes(sshMatch[2]));
    return `https://${host}/${path}`;
  }

  const normalized = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, (scheme) => scheme.toLowerCase());
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`Invalid origin URL: ${raw}`);
  }

  const host = url.hostname.toLowerCase();
  const path = stripTrailingGit(stripSlashes(url.pathname));
  return `https://${host}${path}`;
}

export function relativeSubdir(gitRoot: string, projectPath: string): string {
  const rel = relative(resolve(gitRoot), resolve(projectPath));
  if (rel === "" || rel === ".") return "";

  const relSegments = rel.split(sep);
  if (relSegments[0] === "..") {
    throw new Error(`projectPath ${projectPath} is not within gitRoot ${gitRoot}`);
  }

  return relSegments.join("/");
}

export function deriveStorageKey({ originUrl, gitRoot, projectPath }: StorageKeyInput): string {
  const normalizedOrigin = originUrl !== null ? normalizeOriginUrl(originUrl) : `local://${resolve(gitRoot)}`;
  const subdir = relativeSubdir(gitRoot, projectPath);
  const raw = `${normalizedOrigin}#${subdir}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function stripTrailingGit(value: string): string {
  return value.replace(/\.git$/i, "");
}

function stripSlashes(value: string): string {
  if (value === "/") return "";
  return value.replace(/\/+$/, "");
}
