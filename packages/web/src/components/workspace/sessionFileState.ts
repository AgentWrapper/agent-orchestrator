"use client";

export interface SessionFileState {
  filePath: string;
  scrollTop: number;
  updatedAt: number;
}

interface StoredState {
  currentFile: string;
  files: Record<string, { scrollTop: number; updatedAt: number }>;
}

const MAX_FILES = 20;

function getStorageKey(sessionId: string): string {
  return `workspace:last-opened:${sessionId}`;
}

function readStored(sessionId: string): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Migrate legacy single-entry format
    if (typeof parsed.filePath === "string") {
      const legacy = parsed as { filePath: string; scrollTop?: number; updatedAt?: number };
      return {
        currentFile: legacy.filePath,
        files: {
          [legacy.filePath]: {
            scrollTop: typeof legacy.scrollTop === "number" ? Math.max(0, legacy.scrollTop) : 0,
            updatedAt: typeof legacy.updatedAt === "number" ? legacy.updatedAt : Date.now(),
          },
        },
      };
    }

    if (typeof parsed.currentFile !== "string" || typeof parsed.files !== "object" || !parsed.files) {
      return null;
    }
    return parsed as unknown as StoredState;
  } catch {
    return null;
  }
}

function writeStored(sessionId: string, state: StoredState): void {
  if (typeof window === "undefined") return;
  try {
    const entries = Object.entries(state.files);
    if (entries.length > MAX_FILES) {
      entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const trimmed = entries.slice(entries.length - MAX_FILES);
      state = { ...state, files: Object.fromEntries(trimmed) };
    }
    window.sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function loadSessionFileState(sessionId: string): SessionFileState | null {
  const stored = readStored(sessionId);
  if (!stored || !stored.currentFile) return null;
  const entry = stored.files[stored.currentFile];
  return {
    filePath: stored.currentFile,
    scrollTop: entry ? Math.max(0, entry.scrollTop) : 0,
    updatedAt: entry?.updatedAt ?? Date.now(),
  };
}

export function loadFileScrollTop(sessionId: string, filePath: string): number {
  const stored = readStored(sessionId);
  if (!stored) return 0;
  return Math.max(0, stored.files[filePath]?.scrollTop ?? 0);
}

export function saveSessionFileState(sessionId: string, state: SessionFileState): void {
  const existing = readStored(sessionId);
  const files = existing?.files ?? {};
  files[state.filePath] = { scrollTop: state.scrollTop, updatedAt: state.updatedAt };
  writeStored(sessionId, { currentFile: state.filePath, files });
}
