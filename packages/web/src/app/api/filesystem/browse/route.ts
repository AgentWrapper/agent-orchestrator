import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  PathSecurityError,
  assertDirectoryPath,
  shouldHideBrowseEntry,
} from "@/lib/path-security";

export const dynamic = "force-dynamic";

interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  hasLocalConfig: boolean;
}

function isGitRepository(entryPath: string): boolean {
  try {
    return readdirSync(entryPath).includes(".git");
  } catch {
    return false;
  }
}

function hasLocalConfig(entryPath: string): boolean {
  try {
    const names = new Set(readdirSync(entryPath));
    return names.has("agent-orchestrator.yaml") || names.has("agent-orchestrator.yml");
  } catch {
    return false;
  }
}

function serializeEntry(rootPath: string, parentPath: string, entry: Dirent): BrowseEntry | null {
  const entryPath = path.join(parentPath, entry.name);
  if (shouldHideBrowseEntry(entryPath, rootPath)) {
    return null;
  }

  const isDirectory = entry.isDirectory();
  return {
    name: entry.name,
    isDirectory,
    isGitRepo: isDirectory ? isGitRepository(entryPath) : false,
    hasLocalConfig: isDirectory ? hasLocalConfig(entryPath) : false,
  };
}

export async function GET(request: NextRequest) {
  const requestedPath = request.nextUrl.searchParams.get("path") ?? "~";

  let resolved;
  try {
    resolved = assertDirectoryPath(requestedPath);
  } catch (error) {
    if (!(error instanceof PathSecurityError)) {
      return NextResponse.json({ error: "Failed to browse directory" }, { status: 500 });
    }

    if (error.kind === "outside_root") {
      return NextResponse.json({ error: "path outside allowed root" }, { status: 400 });
    }
    if (error.kind === "restricted") {
      return NextResponse.json({ error: "path is restricted" }, { status: 400 });
    }
    if (error.kind === "not_found") {
      return NextResponse.json({ error: "path not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
  }

  try {
    const entries = readdirSync(resolved.resolvedPath, { withFileTypes: true })
      .map((entry) => serializeEntry(resolved.rootPath, resolved.resolvedPath, entry))
      .filter((entry): entry is BrowseEntry => entry !== null)
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) {
          return left.isDirectory ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ error: "Failed to browse directory" }, { status: 500 });
  }
}
