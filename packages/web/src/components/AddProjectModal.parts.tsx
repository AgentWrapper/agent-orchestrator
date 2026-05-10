import type { ReactNode } from "react";

const RECENT_PATHS_KEY = "ao:add-project:recent";
const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:[\\/]?$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const UNC_ROOT_PATTERN = /^\\\\[^\\]+\\[^\\]+\\?$/;

export function deriveProjectIdFromPath(input: string): string {
  const segment = input.split(/[\\/]+/).filter(Boolean).pop() ?? "project";
  const normalized = segment.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

export function deriveProjectNameFromPath(input: string): string {
  const segment = input.split(/[\\/]+/).filter(Boolean).pop() ?? "Project";
  return segment.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (char) => char.toUpperCase()) || "Project";
}

function preferredSeparator(input: string): "/" | "\\" {
  return input.includes("\\") ? "\\" : "/";
}

function trimBrowsePathEnd(input: string): string {
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(input) || UNC_ROOT_PATTERN.test(input)) return input;
  return input.replace(/[\\/]+$/, "");
}

export function joinBrowsePath(base: string, child: string): string {
  if (base === "~") return `~/${child}`;
  const separator = preferredSeparator(base);
  const normalizedBase = trimBrowsePathEnd(base);
  if (/[\\/]$/.test(normalizedBase)) return `${normalizedBase}${child}`;
  return `${normalizedBase}${separator}${child}`;
}

export function getParentBrowsePath(currentPath: string): string | null {
  if (currentPath === "~") return null;
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(currentPath) || UNC_ROOT_PATTERN.test(currentPath)) return null;
  if (WINDOWS_ABSOLUTE_PATTERN.test(currentPath)) {
    const separator = preferredSeparator(currentPath);
    const normalizedPath = trimBrowsePathEnd(currentPath);
    const parts = normalizedPath.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) return `${parts[0]}${separator}`;
    if (parts.length === 2) return `${parts[0]}${separator}`;
    return parts.slice(0, -1).join(separator);
  }
  const parts = currentPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return "~";
  return parts[0] === "~" ? `~/${parts.slice(1, -1).join("/")}` : parts.slice(0, -1).join("/");
}

export function getBreadcrumbs(currentPath: string): Array<{ label: string; path: string }> {
  if (currentPath === "~") return [{ label: "home", path: "~" }];
  if (WINDOWS_DRIVE_ROOT_PATTERN.test(currentPath)) {
    const separator = preferredSeparator(currentPath);
    const label = currentPath.slice(0, 2);
    return [{ label, path: `${label}${separator}` }];
  }
  if (WINDOWS_ABSOLUTE_PATTERN.test(currentPath)) {
    const separator = preferredSeparator(currentPath);
    const parts = trimBrowsePathEnd(currentPath).split(/[\\/]+/).filter(Boolean);
    const drive = parts[0] ?? currentPath.slice(0, 2);
    let running = `${drive}${separator}`;
    const crumbs: Array<{ label: string; path: string }> = [{ label: drive, path: running }];
    for (const part of parts.slice(1)) {
      running = joinBrowsePath(running, part);
      crumbs.push({ label: part, path: running });
    }
    return crumbs;
  }
  const parts = currentPath.split(/[\\/]+/).filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [{ label: "home", path: "~" }];
  let running = "~";
  for (const part of parts.slice(1)) {
    running = running === "~" ? `~/${part}` : `${running}/${part}`;
    crumbs.push({ label: part, path: running });
  }
  return crumbs;
}

export function loadRecentPaths(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_PATHS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecentPath(input: string) {
  if (typeof window === "undefined") return;
  const next = [input, ...loadRecentPaths().filter((value) => value !== input)].slice(0, 5);
  window.localStorage.setItem(RECENT_PATHS_KEY, JSON.stringify(next));
}

function Glyph({
  children,
  className,
  viewBox = "0 0 16 16",
}: {
  children: ReactNode;
  className?: string;
  viewBox?: string;
}) {
  return <svg aria-hidden="true" viewBox={viewBox} className={className}>{children}</svg>;
}

export function SidebarSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="add-project-browser__sidebar-section">
      <button type="button" className="add-project-browser__sidebar-toggle" onClick={onToggle}>
        <span>{title}</span>
        <span className={`add-project-browser__sidebar-chevron${open ? " is-open" : ""}`}>∨</span>
      </button>
      {open ? <div className="add-project-browser__sidebar-body">{children}</div> : null}
    </section>
  );
}

const iconPath = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "miter" as const };
const iconStroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "square" as const };
const compoundStroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "square" as const, strokeLinejoin: "miter" as const };

export function HomeIcon({ className }: { className?: string }) {
  return <Glyph className={className}><path d="M2 7.5 8 3l6 4.5V14H9.5V10h-3v4H2Z" {...iconPath} /></Glyph>;
}

export function FolderIcon({ className }: { className?: string }) {
  return <Glyph className={className}><path d="M2 4.5h4l1.5 2H14v5.5H2Z" {...iconPath} /></Glyph>;
}

export function ChevronLeftIcon() {
  return <Glyph className="add-project-modal__toolicon"><path d="M10 3.5 6 8l4 4.5" {...iconStroke} /></Glyph>;
}

export function ChevronRightIcon() {
  return <Glyph className="add-project-modal__toolicon"><path d="m6 3.5 4 4.5L6 12.5" {...iconStroke} /></Glyph>;
}

export function ArrowUpIcon() {
  return <Glyph className="add-project-modal__toolicon"><path d="M8 12V4m0 0L5 7m3-3 3 3" {...compoundStroke} /></Glyph>;
}

export function RefreshIcon() {
  return <Glyph className="add-project-modal__toolicon"><path d="M12 5V2.75H9.75M4.5 11A4.75 4.75 0 0 0 12 5M3.75 11v2.25H6m5.5-8.25A4.75 4.75 0 0 1 4 11" {...compoundStroke} /></Glyph>;
}

export function SortChevronIcon() {
  return <Glyph className="add-project-browser__sorticon"><path d="m4.5 6 3.5 4 3.5-4" {...compoundStroke} /></Glyph>;
}
