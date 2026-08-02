"use client";

import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  File,
  Files,
  Folder,
  GitCompareArrows,
  Globe2,
  LoaderCircle,
  PanelRightClose,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import {
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  CloudAPI,
  CloudWorkspaceDiff,
  CloudWorkspaceEntry,
} from "@/lib/cloud-api";
import {
  getWorkspaceSnapshot,
  subscribeWorkspaceSnapshot,
  warmWorkspaceSession,
} from "@/lib/cloud-workspace-cache";

import { CloudTerminal } from "./CloudTerminal";

export type CloudInspectorTab = "changes" | "browser" | "terminal" | "files";

interface CloudInspectorProps {
  api: CloudAPI;
  orgId: string;
  sessionId: string;
  runtimeConnected: boolean;
  previewAddress?: string;
  tab: CloudInspectorTab;
  open: boolean;
  width: number;
  onTabChange: (tab: CloudInspectorTab) => void;
  onPreviewAddressChange: (address: string) => void;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}

const inspectorTabs: {
  id: CloudInspectorTab;
  label: string;
  icon: typeof GitCompareArrows;
}[] = [
  { id: "changes", label: "Changes", icon: GitCompareArrows },
  { id: "browser", label: "Browser", icon: Globe2 },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "files", label: "Files", icon: Files },
];

export function CloudInspector({
  api,
  orgId,
  sessionId,
  runtimeConnected,
  previewAddress,
  tab,
  open,
  width,
  onTabChange,
  onPreviewAddressChange,
  onWidthChange,
  onClose,
}: CloudInspectorProps) {
  useEffect(() => {
    if (open && runtimeConnected) void warmWorkspaceSession(api, orgId, sessionId);
  }, [api, open, orgId, runtimeConnected, sessionId]);

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = width;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const maximum = Math.max(360, Math.floor(window.innerWidth * 0.7));
      onWidthChange(
        Math.min(
          maximum,
          Math.max(320, originWidth + originX - moveEvent.clientX),
        ),
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
  };

  return (
    <aside
      className="relative h-full min-h-0 shrink-0 overflow-hidden bg-[#111316] transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{
        width: open ? width : 0,
        borderLeft: open ? "1px solid #24272d" : "0 solid transparent",
      }}
      aria-label="Session inspector"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="flex h-full min-h-0 flex-col" style={{ width }}>
        {open ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize session inspector"
            onPointerDown={startResize}
            className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none"
          />
        ) : null}
        <div className="flex h-10 shrink-0 items-center border-b border-[#24272d] px-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {inspectorTabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onTabChange(item.id)}
                  className={`flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def] ${
                    tab === item.id
                      ? "bg-[#262a31] text-[#eef0f3]"
                      : "text-[#8f96a1] hover:bg-[#202329] hover:text-[#d9dce1]"
                  }`}
                  aria-pressed={tab === item.id}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def]"
            aria-label="Close inspector"
            title="Close inspector"
          >
            <PanelRightClose className="size-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          {!open ? null : !runtimeConnected ? (
            <InspectorUnavailable />
          ) : tab === "changes" ? (
            <ChangesView api={api} orgId={orgId} sessionId={sessionId} />
          ) : tab === "browser" ? (
            <BrowserView
              api={api}
              orgId={orgId}
              sessionId={sessionId}
              requestedAddress={previewAddress}
              onAddressChange={onPreviewAddressChange}
            />
          ) : tab === "terminal" ? (
            <CloudTerminal
              api={api}
              orgId={orgId}
              sessionId={sessionId}
              kind="workspace"
            />
          ) : (
            <FilesView
              api={api}
              orgId={orgId}
              sessionId={sessionId}
              onPreview={(path) => {
                onPreviewAddressChange(
                  `file:///workspace/repository/${path.replace(/^\/+/, "")}`,
                );
                onTabChange("browser");
              }}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

function InspectorUnavailable() {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div>
        <LoaderCircle className="mx-auto mb-3 size-4 animate-spin text-[#6f9eff] motion-reduce:animate-none" />
        <p className="text-xs text-[#c4c8cf]">VM is loading…</p>
      </div>
    </div>
  );
}

function useWorkspaceSnapshot(sessionId: string) {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeWorkspaceSnapshot(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => getWorkspaceSnapshot(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => undefined);
}

type DiffLineKind = "context" | "addition" | "deletion" | "hunk" | "meta";

interface InspectorDiffLine {
  kind: DiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface InspectorDiffFile {
  key: string;
  path: string;
  state: string;
  additions: number;
  deletions: number;
  lines: InspectorDiffLine[];
  detail?: string;
}

function ChangesView({
  api,
  orgId,
  sessionId,
}: {
  api: CloudAPI;
  orgId: string;
  sessionId: string;
}) {
  const snapshot = useWorkspaceSnapshot(sessionId);
  const diff = snapshot?.diff ?? null;
  const [selectedKey, setSelectedKey] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [untrackedPreviews, setUntrackedPreviews] = useState<
    Record<string, { content?: string; detail?: string; loading?: boolean }>
  >({});
  const untrackedRequests = useRef(new Set<string>());
  const loadedUntrackedPreviews = useRef(new Set<string>());
  const files = useMemo(() => {
    if (!diff) return [];
    const parsedFiles = parseWorkspaceDiff(diff);
    const representedPaths = new Set(parsedFiles.map((file) => file.path));
    const statusOnlyFiles = parseGitStatus(diff.status)
      .filter((entry) => !representedPaths.has(entry.path))
      .map((entry) => {
        const statusFile = statusOnlyDiffFile(entry);
        const preview = untrackedPreviews[entry.path];
        if (entry.code !== "??" || !preview) return statusFile;
        if (preview.content !== undefined) {
          return {
            ...untrackedDiffFile(entry.path, preview.content),
            key: statusFile.key,
          };
        }
        return {
          ...statusFile,
          detail: preview.loading ? "Loading preview…" : preview.detail,
        };
      });
    return [...parsedFiles, ...statusOnlyFiles];
  }, [diff, untrackedPreviews]);
  const selectedFile =
    files.find((file) => file.key === selectedKey) ?? null;
  const selectedUntrackedPath = useMemo(() => {
    if (!diff || !selectedKey) return "";
    return (
      parseGitStatus(diff.status).find(
        (entry) =>
          entry.code === "??" &&
          statusOnlyDiffFile(entry).key === selectedKey,
      )?.path ?? ""
    );
  }, [diff, selectedKey]);

  useEffect(() => {
    if (
      !selectedUntrackedPath ||
      loadedUntrackedPreviews.current.has(selectedUntrackedPath) ||
      untrackedRequests.current.has(selectedUntrackedPath)
    ) {
      return;
    }
    let cancelled = false;
    untrackedRequests.current.add(selectedUntrackedPath);
    setUntrackedPreviews((current) => ({
      ...current,
      [selectedUntrackedPath]: { loading: true },
    }));
    void api
      .workspaceFile(orgId, sessionId, selectedUntrackedPath)
      .then((response) => {
        if (cancelled) return;
        loadedUntrackedPreviews.current.add(selectedUntrackedPath);
        setUntrackedPreviews((current) => ({
          ...current,
          [selectedUntrackedPath]: { content: response.content },
        }));
      })
      .catch((readError: unknown) => {
        if (cancelled) return;
        loadedUntrackedPreviews.current.add(selectedUntrackedPath);
        setUntrackedPreviews((current) => ({
          ...current,
          [selectedUntrackedPath]: {
            detail:
              readError instanceof Error
                ? readError.message
                : "Preview unavailable for this file.",
          },
        }));
      })
      .finally(() => {
        untrackedRequests.current.delete(selectedUntrackedPath);
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedUntrackedPath, sessionId]);

  useEffect(() => {
    if (selectedKey && !selectedFile) setSelectedKey("");
  }, [selectedFile, selectedKey]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void warmWorkspaceSession(api, orgId, sessionId).finally(() =>
      setRefreshing(false),
    );
  }, [api, sessionId]);
  const loading = refreshing || (!diff && !snapshot?.diffError);
  const error = snapshot?.diffError ?? "";
  const totals = files.reduce(
    (summary, file) => ({
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <InspectorToolbar
        label="Changes"
        loading={loading}
        onRefresh={refresh}
        summary={
          files.length
            ? `${files.length} ${files.length === 1 ? "file" : "files"}`
            : undefined
        }
      />
      {error ? (
        <InspectorError message={error} />
      ) : loading && !diff ? (
        <InspectorLoading label="Reading Git changes…" />
      ) : files.length === 0 ? (
        <InspectorEmpty
          icon={GitCompareArrows}
          title="Working tree is clean"
          detail="Changes made by the worker will appear here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto bg-[#0f1114]">
          <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-[#24272d] bg-[#111316]/95 px-3 backdrop-blur">
            <span className="min-w-0 flex-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[#777e89]">
              Working Tree
            </span>
            {selectedKey ? (
              <button
                type="button"
                onClick={() => setSelectedKey("")}
                className="rounded px-1.5 py-1 text-[9px] text-[#7f8792] hover:bg-[#202329] hover:text-[#d9dce1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def]"
              >
                Collapse All
              </button>
            ) : null}
            <DiffCount
              additions={totals.additions}
              deletions={totals.deletions}
            />
          </div>
          <div>
            {files.map((file) => {
              const expanded =
                selectedFile?.key === file.key && Boolean(selectedKey);
              return (
                <section key={file.key} className="border-b border-[#24272d]">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedKey((current) =>
                        current === file.key ? "" : file.key,
                      )
                    }
                    className={`flex min-h-11 w-full items-center gap-2 px-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#5b8def] ${
                      expanded
                        ? "bg-[#1b1e23] text-[#eef0f3]"
                        : "bg-[#14161a] text-[#b6bbc3] hover:bg-[#1a1d22] hover:text-[#e1e4e8]"
                    }`}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? "Collapse" : "Expand"} ${file.path}, ${file.additions} additions, ${file.deletions} deletions`}
                  >
                    <ChevronRight
                      className={`size-3.5 shrink-0 text-[#69717c] transition-transform duration-150 motion-reduce:transition-none ${
                        expanded ? "rotate-90" : ""
                      }`}
                      aria-hidden="true"
                    />
                    <span
                      className={`w-4 shrink-0 font-mono text-[10px] ${
                        file.state === "Untracked"
                          ? "text-[#7fa7ff]"
                          : file.state === "Staged"
                            ? "text-[#75d291]"
                            : "text-[#d7aa61]"
                      }`}
                    >
                      {diffStateGlyph(file.state)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate font-mono text-[11px] text-[#d8dce2]">
                          {diffBaseName(file.path)}
                        </span>
                        {diffDirectory(file.path) ? (
                          <span className="truncate font-mono text-[9px] text-[#626a75]">
                            {diffDirectory(file.path)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <DiffCount
                      additions={file.additions}
                      deletions={file.deletions}
                    />
                    <span className="rounded border border-[#6d343a] bg-[#3a2024] px-1.5 py-0.5 text-[9px] text-[#e28a91]">
                      {file.state}
                    </span>
                  </button>
                  {expanded ? <DiffFileView file={file} /> : null}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffFileView({ file }: { file: InspectorDiffFile }) {
  return (
    <div className="min-w-0 border-t border-[#24272d]">
      {file.lines.length ? (
        <div className="overflow-x-auto bg-[#0f1114] font-mono text-[11px] leading-5">
          <div className="min-w-max py-1">
            {file.lines.map((line, index) => (
              <div
                key={`${index}-${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
                className={`grid min-h-5 grid-cols-[42px_42px_20px_minmax(max-content,1fr)] ${
                  line.kind === "addition"
                    ? "bg-[#173321]/65 text-[#8bdda3]"
                    : line.kind === "deletion"
                      ? "bg-[#3a1e23]/65 text-[#f09aa1]"
                      : line.kind === "hunk"
                        ? "bg-[#18243b]/60 text-[#88aefc]"
                        : line.kind === "meta"
                          ? "text-[#737b87]"
                          : "text-[#bdc2ca]"
                }`}
              >
                <span className="select-none border-r border-[#25282e] px-2 text-right tabular-nums text-[#555d68]">
                  {line.oldLine ?? ""}
                </span>
                <span className="select-none border-r border-[#25282e] px-2 text-right tabular-nums text-[#555d68]">
                  {line.newLine ?? ""}
                </span>
                <span
                  className="select-none text-center font-semibold"
                  aria-hidden="true"
                >
                  {line.kind === "addition"
                    ? "+"
                    : line.kind === "deletion"
                      ? "−"
                      : ""}
                </span>
                <code className="whitespace-pre pr-4">
                  {line.content || " "}
                </code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <InspectorEmpty
          icon={File}
          title="No textual diff available"
          detail={
            file.detail ??
            "The file may be binary, empty, or only changed in metadata."
          }
        />
      )}
    </div>
  );
}

function DiffCount({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums"
      aria-label={`${additions} additions and ${deletions} deletions`}
    >
      <span className="text-[#75d291]">+{additions}</span>
      <span className="text-[#ef8a92]">−{deletions}</span>
    </span>
  );
}

function parseWorkspaceDiff(diff: CloudWorkspaceDiff): InspectorDiffFile[] {
  return [
    ...parseUnifiedDiff(diff.staged, "Staged"),
    ...parseUnifiedDiff(diff.unstaged, "Unstaged"),
  ];
}

function parseUnifiedDiff(patch: string, state: string): InspectorDiffFile[] {
  if (!patch.trim()) return [];
  return patch
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk, index) => {
      const rawLines = chunk.split("\n");
      const newPathLine = rawLines.find((line) => line.startsWith("+++ "));
      const oldPathLine = rawLines.find((line) => line.startsWith("--- "));
      const header = rawLines[0] ?? "";
      const path =
        normalizeDiffPath(newPathLine?.slice(4)) ??
        normalizeDiffPath(oldPathLine?.slice(4)) ??
        fallbackDiffPath(header) ??
        `Changed file ${index + 1}`;
      const lines = parseDiffLines(rawLines);
      return {
        key: `${state.toLowerCase()}:${path}:${index}`,
        path,
        state,
        additions: lines.filter((line) => line.kind === "addition").length,
        deletions: lines.filter((line) => line.kind === "deletion").length,
        lines,
      };
    });
}

function parseDiffLines(rawLines: string[]): InspectorDiffLine[] {
  const lines: InspectorDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  for (const rawLine of rawLines) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      lines.push({ kind: "hunk", content: rawLine });
      continue;
    }
    if (!insideHunk) {
      if (
        rawLine.startsWith("Binary files ") ||
        rawLine.startsWith("GIT binary patch")
      ) {
        lines.push({ kind: "meta", content: rawLine });
      }
      continue;
    }
    if (rawLine.startsWith("\\ No newline")) {
      lines.push({ kind: "meta", content: rawLine });
    } else if (rawLine.startsWith("+")) {
      lines.push({ kind: "addition", content: rawLine.slice(1), newLine });
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      lines.push({ kind: "deletion", content: rawLine.slice(1), oldLine });
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      lines.push({
        kind: "context",
        content: rawLine.slice(1),
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return lines;
}

function parseGitStatus(status: string) {
  return status
    .split("\n")
    .filter((line) => line.length >= 3)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      return {
        code: line.slice(0, 2),
        path: rawPath.includes(" -> ")
          ? rawPath.split(" -> ").at(-1)!
          : rawPath,
      };
    });
}

function statusOnlyDiffFile(entry: {
  code: string;
  path: string;
}): InspectorDiffFile {
  return {
    key: `status:${entry.code}:${entry.path}`,
    path: entry.path,
    state: statusLabel(entry.code),
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

function untrackedDiffFile(path: string, content: string): InspectorDiffFile {
  const contentLines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.split("\n");
  const normalizedLines = content === "" ? [] : contentLines;
  return {
    key: `untracked:${path}`,
    path,
    state: "Untracked",
    additions: normalizedLines.length,
    deletions: 0,
    lines: [
      {
        kind: "hunk",
        content: `@@ -0,0 +1,${normalizedLines.length} @@`,
      },
      ...normalizedLines.map((line, index) => ({
        kind: "addition" as const,
        content: line,
        newLine: index + 1,
      })),
    ],
  };
}

function normalizeDiffPath(rawPath?: string) {
  if (!rawPath) return null;
  const withoutTimestamp = rawPath.split("\t")[0];
  if (withoutTimestamp === "/dev/null") return null;
  const unquoted =
    withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"')
      ? safelyUnquoteGitPath(withoutTimestamp)
      : withoutTimestamp;
  return unquoted.replace(/^[ab]\//, "");
}

function safelyUnquoteGitPath(path: string) {
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

function fallbackDiffPath(header: string) {
  const marker = header.lastIndexOf(" b/");
  return marker >= 0 ? header.slice(marker + 3) : null;
}

function statusLabel(code: string) {
  if (code === "??") return "Untracked";
  if (code.includes("A")) return "Added";
  if (code.includes("D")) return "Deleted";
  if (code.includes("R")) return "Renamed";
  return code[0] !== " " ? "Staged" : "Modified";
}

function diffStateGlyph(state: string) {
  if (state === "Untracked") return "U";
  if (state === "Added") return "A";
  if (state === "Deleted") return "D";
  if (state === "Renamed") return "R";
  return "M";
}

function diffBaseName(path: string) {
  return path.split("/").at(-1) ?? path;
}

function diffDirectory(path: string) {
  const separator = path.lastIndexOf("/");
  return separator >= 0 ? path.slice(0, separator + 1) : "";
}

function BrowserView({
  api,
  orgId,
  sessionId,
  requestedAddress,
  onAddressChange,
}: {
  api: CloudAPI;
  orgId: string;
  sessionId: string;
  requestedAddress?: string;
  onAddressChange: (address: string) => void;
}) {
  const [address, setAddress] = useState("http://localhost:3000");
  const [loadedAddress, setLoadedAddress] = useState("");
  const [previewURL, setPreviewURL] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const navigate = useCallback(
    async (target: string) => {
      setLoading(true);
      setError("");
      try {
        const parsed = parsePreviewAddress(target);
        if (parsed.kind === "file") {
          const response = await api.workspaceFilePreviewTicket(
            orgId,
            sessionId,
            parsed.path,
          );
          setPreviewURL(response.url);
        } else {
          const response = await api.workspacePreviewTicket(
            orgId,
            sessionId,
            parsed.port,
          );
          setPreviewURL(
            `${response.url}${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`,
          );
        }
        setLoadedAddress(parsed.href);
        setAddress(parsed.href);
        onAddressChange(parsed.href);
      } catch (navigationError) {
        setPreviewURL("");
        setError(
          navigationError instanceof Error
            ? navigationError.message
            : "Could not open preview.",
        );
      } finally {
        setLoading(false);
      }
    },
    [api, onAddressChange, orgId, sessionId],
  );

  useEffect(() => {
    if (!requestedAddress) return;
    setAddress(requestedAddress);
    void navigate(requestedAddress);
  }, [navigate, requestedAddress]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f1114]">
      <form
        className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[#24272d] px-2"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate(address);
        }}
      >
        <button
          type="button"
          disabled
          className="grid size-6 place-items-center text-[#535962]"
          aria-label="Back"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          disabled
          className="grid size-6 place-items-center text-[#535962]"
          aria-label="Forward"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (previewURL) setReloadKey((current) => current + 1);
            else void navigate(loadedAddress || address);
          }}
          className="grid size-6 place-items-center rounded text-[#89909b] hover:bg-[#24272d] hover:text-[#e3e6ea] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def]"
          aria-label="Reload preview"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Preview address"
          name="preview-address"
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-[#2a2e35] bg-[#181b20] px-2.5 font-mono text-[11px] text-[#d4d7dc] outline-none placeholder:text-[#636a74] focus-visible:border-[#4d75c9] focus-visible:ring-1 focus-visible:ring-[#4d75c9]"
          placeholder="localhost:3000 or file:///workspace/repository/index.html"
        />
      </form>
      <div className="min-h-0 flex-1">
        {error ? (
          <InspectorError message={error} />
        ) : !previewURL ? (
          <InspectorEmpty
            icon={Globe2}
            title="Open a worker preview"
            detail="Enter a localhost URL or a file path inside /workspace/repository."
          />
        ) : (
          <iframe
            key={`${previewURL}-${reloadKey}`}
            title="Worker preview"
            src={previewURL}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

function FilesView({
  api,
  orgId,
  sessionId,
  onPreview,
}: {
  api: CloudAPI;
  orgId: string;
  sessionId: string;
  onPreview: (path: string) => void;
}) {
  const snapshot = useWorkspaceSnapshot(sessionId);
  const cachedRootEntries = snapshot?.rootEntries;
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<CloudWorkspaceEntry[]>(() =>
    sortWorkspaceEntries(cachedRootEntries ?? []),
  );
  const [file, setFile] = useState<{ path: string; content: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!cachedRootEntries);

  const loadDirectory = useCallback(
    async (target: string) => {
      setLoading(true);
      setError("");
      setFile(null);
      if (target === "") {
        setPath("");
        try {
          await warmWorkspaceSession(api, orgId, sessionId);
        } finally {
          setLoading(false);
        }
        return;
      }
      try {
        const response = await api.workspaceFiles(orgId, sessionId, target);
        setPath(response.path === "." ? "" : response.path);
        setEntries(sortWorkspaceEntries(response.entries));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load files.",
        );
      } finally {
        setLoading(false);
      }
    },
    [api, orgId, sessionId],
  );

  useEffect(() => {
    if (file || path) return;
    if (snapshot?.rootEntries) {
      setEntries(sortWorkspaceEntries(snapshot.rootEntries));
      setLoading(false);
    }
    setError(snapshot?.filesError ?? "");
  }, [file, path, snapshot]);

  const openFile = async (entry: CloudWorkspaceEntry) => {
    if (entry.isDir) {
      await loadDirectory(entry.path);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await api.workspaceFile(orgId, sessionId, entry.path);
      setFile(response);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not open file.",
      );
    } finally {
      setLoading(false);
    }
  };

  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <InspectorToolbar
        label={file?.path || (path ? `repo/${path}` : "Repository")}
        loading={loading}
        onRefresh={() =>
          file
            ? void openFile({
                name: file.path.split("/").at(-1) ?? file.path,
                path: file.path,
                isDir: false,
                size: 0,
                mode: "",
                modTime: "",
              })
            : void loadDirectory(path)
        }
        action={
          file && /\.(?:html?|svg)$/i.test(file.path)
            ? {
                label: "Open in Browser",
                icon: Globe2,
                onClick: () => onPreview(file.path),
              }
            : undefined
        }
        back={
          file
            ? () => setFile(null)
            : path
              ? () => void loadDirectory(parent)
              : undefined
        }
      />
      {error ? (
        <InspectorError message={error} />
      ) : file ? (
        <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-[1.65] text-[#c7cbd2]">
          {file.content}
        </pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {entries.map((entry) => {
            const Icon = entry.isDir ? Folder : File;
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => void openFile(entry)}
                className="flex h-7 w-full items-center gap-2 px-3 text-left text-[11px] text-[#b6bbc3] hover:bg-[#202329] hover:text-[#edf0f3]"
              >
                <Icon
                  className={`size-3.5 shrink-0 ${
                    entry.isDir ? "text-[#7b9bd6]" : "text-[#777e88]"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {!entry.isDir ? (
                  <span className="shrink-0 font-mono text-[9px] text-[#606771]">
                    {formatBytes(entry.size)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InspectorToolbar({
  label,
  loading,
  onRefresh,
  back,
  summary,
  action,
}: {
  label: string;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  back?: () => void;
  summary?: string;
  action?: {
    label: string;
    icon: typeof Globe2;
    onClick: () => void;
  };
}) {
  const ActionIcon = action?.icon;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#24272d] px-2">
      {back ? (
        <button
          type="button"
          onClick={back}
          className="grid size-6 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb]"
          aria-label="Go back"
        >
          <ArrowLeft className="size-3.5" />
        </button>
      ) : null}
      <span className="min-w-0 flex-1 truncate px-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[#777e89]">
        {label}
      </span>
      {summary ? (
        <span className="font-mono text-[9px] tabular-nums text-[#69717c]">
          {summary}
        </span>
      ) : null}
      {action && ActionIcon ? (
        <button
          type="button"
          onClick={action.onClick}
          className="grid size-6 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def]"
          aria-label={action.label}
          title={action.label}
        >
          <ActionIcon className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="grid size-6 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#5b8def]"
        aria-label="Refresh"
      >
        <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}

function InspectorLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-[11px] text-[#777e89]">
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-3.5 animate-spin" />
        {label}
      </span>
    </div>
  );
}

function InspectorError({ message }: { message: string }) {
  return (
    <div className="m-3 rounded-md border border-[#713b42] bg-[#331d21] px-3 py-2 text-[11px] leading-5 text-[#efa0a7]">
      {message}
    </div>
  );
}

function InspectorEmpty({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Globe2;
  title: string;
  detail: string;
}) {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div>
        <Icon
          className="mx-auto mb-3 size-5 text-[#555d68]"
          strokeWidth={1.5}
        />
        <p className="text-xs text-[#bdc2ca]">{title}</p>
        <p className="mt-1 max-w-56 text-[11px] leading-5 text-[#6f7681]">
          {detail}
        </p>
      </div>
    </div>
  );
}

function parsePreviewAddress(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("file://") ||
    trimmed === "/workspace/repository" ||
    trimmed.startsWith("/workspace/repository/")
  ) {
    const parsed = trimmed.startsWith("file://")
      ? new URL(trimmed)
      : new URL(`file://${trimmed}`);
    if (parsed.protocol !== "file:" || parsed.hostname) {
      throw new Error("File previews must use the worker repository path.");
    }
    const repositoryRoot = "/workspace/repository/";
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath.startsWith(repositoryRoot)) {
      throw new Error("File previews must stay inside /workspace/repository.");
    }
    const relativePath = decodedPath.slice(repositoryRoot.length);
    if (!relativePath || relativePath.split("/").includes("..")) {
      throw new Error("Choose a file inside /workspace/repository.");
    }
    return {
      kind: "file" as const,
      path: relativePath,
      href: `file://${repositoryRoot}${relativePath}`,
    };
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? trimmed
    : `http://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
    throw new Error("Preview URLs must use localhost, 127.0.0.1, or 0.0.0.0.");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (port < 1024 || port > 65535) {
    throw new Error("Use a localhost port between 1024 and 65535.");
  }
  return {
    kind: "server" as const,
    port,
    pathname: parsed.pathname,
    search: parsed.search,
    href: `http://localhost:${port}${parsed.pathname}${parsed.search}`,
  };
}

function sortWorkspaceEntries(entries: CloudWorkspaceEntry[]) {
  return [...entries].sort(
    (left, right) =>
      Number(right.isDir) - Number(left.isDir) ||
      left.name.localeCompare(right.name),
  );
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
