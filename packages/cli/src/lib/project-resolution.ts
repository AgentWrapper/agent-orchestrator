import { isAbsolute, relative, resolve } from "node:path";

interface ProjectWithPath {
  path: string;
}

function isWithinProject(projectPath: string, currentDir: string): boolean {
  const relativePath = relative(projectPath, currentDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Find the best matching project for the current directory.
 * When multiple project paths contain the cwd, prefer the deepest match.
 */
export function findProjectForDirectory<T extends ProjectWithPath>(
  projects: Record<string, T>,
  currentDir: string,
): string | null {
  const resolvedCurrentDir = resolve(currentDir);

  const matches = Object.entries(projects)
    .filter(([, project]) => isWithinProject(resolve(project.path), resolvedCurrentDir))
    .sort(([, a], [, b]) => resolve(b.path).length - resolve(a.path).length);

  return matches[0]?.[0] ?? null;
}
