import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const RESTRICTED_SINGLE_SEGMENTS = new Set([
  ".ssh",
  ".aws",
  ".kube",
  ".gnupg",
  ".agent-orchestrator",
]);

function splitInputSegments(rawPath: string): string[] {
  return rawPath.split(/[\\/]+/).filter(Boolean);
}

function homeRealPath(): string {
  return realpathSync(homedir());
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function containsTraversal(rawPath: string): boolean {
  return splitInputSegments(rawPath).includes("..");
}

function containsRestrictedSegments(targetPath: string, rootPath = homeRealPath()): boolean {
  const relative = path.relative(rootPath, targetPath);
  if (relative === "") return false;

  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    if (RESTRICTED_SINGLE_SEGMENTS.has(segment)) {
      return true;
    }
    if (segment === ".config" && segments[index + 1] === "gcloud") {
      return true;
    }
  }

  return false;
}

function toRequestedAbsolutePath(rawPath: string, rootPath: string): string {
  if (rawPath === "" || rawPath === "~") return rootPath;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.resolve(rootPath, rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return path.resolve(rawPath);
  }
  return path.resolve(rootPath, rawPath);
}

export class PathSecurityError extends Error {
  constructor(
    public readonly kind:
      | "outside_root"
      | "restricted"
      | "not_found"
      | "not_directory",
    message: string,
  ) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export interface ResolvedHomePath {
  rootPath: string;
  resolvedPath: string;
}

export function resolveHomeContainedPath(rawPath: string): ResolvedHomePath {
  const rootPath = homeRealPath();
  const requestedPath = rawPath.trim();

  if (containsTraversal(requestedPath)) {
    throw new PathSecurityError("outside_root", "path outside allowed root");
  }

  const absolutePath = toRequestedAbsolutePath(requestedPath, rootPath);
  let resolvedPath: string;

  try {
    resolvedPath = realpathSync(absolutePath);
  } catch {
    throw new PathSecurityError("not_found", "path not found");
  }

  if (!isWithinRoot(rootPath, resolvedPath)) {
    throw new PathSecurityError("outside_root", "path outside allowed root");
  }

  if (containsRestrictedSegments(resolvedPath, rootPath)) {
    throw new PathSecurityError("restricted", "path is restricted");
  }

  return { rootPath, resolvedPath };
}

export function assertDirectoryPath(rawPath: string): ResolvedHomePath {
  const resolved = resolveHomeContainedPath(rawPath);

  let stats;
  try {
    stats = lstatSync(resolved.resolvedPath);
  } catch {
    throw new PathSecurityError("not_found", "path not found");
  }

  if (!stats.isDirectory()) {
    throw new PathSecurityError("not_directory", "path is not a directory");
  }

  return resolved;
}

export function shouldHideBrowseEntry(entryPath: string, rootPath: string): boolean {
  try {
    if (path.basename(entryPath).startsWith(".")) {
      return true;
    }
    const resolvedEntryPath = realpathSync(entryPath);
    if (!isWithinRoot(rootPath, resolvedEntryPath)) return true;
    return containsRestrictedSegments(resolvedEntryPath, rootPath);
  } catch {
    return true;
  }
}
