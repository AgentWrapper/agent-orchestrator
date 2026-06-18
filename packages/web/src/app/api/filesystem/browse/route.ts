import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isWindows } from "@aoagents/ao-core";
import { NextResponse, type NextRequest } from "next/server";
import { PathSecurityError, assertDirectoryPath, shouldHideBrowseEntry } from "@/lib/path-security";

export const dynamic = "force-dynamic";

interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  hasLocalConfig: boolean;
}

interface BrowseCurrentDirectory {
  isGitRepo: boolean;
  hasLocalConfig: boolean;
}

interface BrowseRoot {
  label: string;
  path: string;
}

function getBrowseRoots(): BrowseRoot[] {
  if (!isWindows()) return [];

  const roots: BrowseRoot[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = String.fromCharCode(code);
    const rootPath = `${drive}:\\`;
    if (existsSync(rootPath)) {
      roots.push({ label: `${drive}:`, path: rootPath });
    }
  }
  return roots;
}

async function describeDirectory(
  entryPath: string,
): Promise<{ isGitRepo: boolean; hasLocalConfig: boolean }> {
  try {
    const names = new Set(await readdir(entryPath));
    return {
      isGitRepo: names.has(".git"),
      hasLocalConfig: names.has("agent-orchestrator.yaml") || names.has("agent-orchestrator.yml"),
    };
  } catch {
    return { isGitRepo: false, hasLocalConfig: false };
  }
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
    const dirents = await readdir(resolved.resolvedPath, { withFileTypes: true });
    const entries = (
      await Promise.all(
        dirents.map(async (entry): Promise<BrowseEntry | null> => {
          const entryPath = path.join(resolved.resolvedPath, entry.name);
          if (shouldHideBrowseEntry(entryPath, resolved.rootPath)) {
            return null;
          }

          const isDirectory = entry.isDirectory();
          const meta = isDirectory
            ? await describeDirectory(entryPath)
            : { isGitRepo: false, hasLocalConfig: false };

          return {
            name: entry.name,
            isDirectory,
            isGitRepo: meta.isGitRepo,
            hasLocalConfig: meta.hasLocalConfig,
          };
        }),
      )
    )
      .filter((entry): entry is BrowseEntry => entry !== null)
      .sort((left, right) =>
        left.isDirectory !== right.isDirectory
          ? left.isDirectory
            ? -1
            : 1
          : left.name.localeCompare(right.name),
      );

    const selfMeta = await describeDirectory(resolved.resolvedPath);
    const current: BrowseCurrentDirectory = {
      isGitRepo: selfMeta.isGitRepo,
      hasLocalConfig: selfMeta.hasLocalConfig,
    };

    return NextResponse.json({ entries, current, roots: getBrowseRoots() });
  } catch {
    return NextResponse.json({ error: "Failed to browse directory" }, { status: 500 });
  }
}
