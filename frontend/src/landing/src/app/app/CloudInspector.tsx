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
import { PointerEvent, useCallback, useEffect, useState } from "react";

import {
  CloudAPI,
  CloudWorkspaceDiff,
  CloudWorkspaceEntry,
} from "@/lib/cloud-api";

import { CloudTerminal } from "./CloudTerminal";

export type CloudInspectorTab = "changes" | "browser" | "terminal" | "files";

interface CloudInspectorProps {
  api: CloudAPI;
  sessionId: string;
  runtimeConnected: boolean;
  previewAddress?: string;
  tab: CloudInspectorTab;
  width: number;
  onTabChange: (tab: CloudInspectorTab) => void;
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
  sessionId,
  runtimeConnected,
  previewAddress,
  tab,
  width,
  onTabChange,
  onWidthChange,
  onClose,
}: CloudInspectorProps) {
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = width;
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const maximum = Math.max(360, Math.floor(window.innerWidth * 0.7));
      onWidthChange(
        Math.min(maximum, Math.max(320, originWidth + originX - moveEvent.clientX)),
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
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-[#24272d] bg-[#111316]"
      style={{ width }}
      aria-label="Session inspector"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize session inspector"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none"
      />
      <div className="flex h-10 shrink-0 items-center border-b border-[#24272d] px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {inspectorTabs.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onTabChange(item.id)}
                className={`flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${
                  tab === item.id
                    ? "bg-[#262a31] text-[#eef0f3]"
                    : "text-[#8f96a1] hover:bg-[#202329] hover:text-[#d9dce1]"
                }`}
                aria-pressed={tab === item.id}
              >
                <Icon className="size-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb]"
          aria-label="Close inspector"
          title="Close inspector"
        >
          <PanelRightClose className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {!runtimeConnected ? (
          <InspectorUnavailable />
        ) : tab === "terminal" ? (
          <CloudTerminal api={api} sessionId={sessionId} />
        ) : tab === "changes" ? (
          <ChangesView api={api} sessionId={sessionId} />
        ) : tab === "browser" ? (
          <BrowserView
            api={api}
            sessionId={sessionId}
            requestedAddress={previewAddress}
          />
        ) : (
          <FilesView api={api} sessionId={sessionId} />
        )}
      </div>
    </aside>
  );
}

function InspectorUnavailable() {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div>
        <LoaderCircle className="mx-auto mb-3 size-4 animate-spin text-[#6f9eff] motion-reduce:animate-none" />
        <p className="text-xs text-[#c4c8cf]">Preparing workspace tools</p>
        <p className="mt-1 text-[11px] leading-5 text-[#777e89]">
          Terminal, files, changes, and previews connect when the worker is ready.
        </p>
      </div>
    </div>
  );
}

function ChangesView({ api, sessionId }: { api: CloudAPI; sessionId: string }) {
  const [diff, setDiff] = useState<CloudWorkspaceDiff | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDiff(await api.workspaceDiff(sessionId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load changes.");
    } finally {
      setLoading(false);
    }
  }, [api, sessionId]);

  useEffect(() => void load(), [load]);
  const patch = [diff?.staged, diff?.unstaged].filter(Boolean).join("\n");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <InspectorToolbar
        label={diff?.status.trim() ? "Working tree" : "Changes"}
        loading={loading}
        onRefresh={load}
      />
      {error ? (
        <InspectorError message={error} />
      ) : loading && !diff ? (
        <InspectorLoading label="Reading Git changes…" />
      ) : !diff?.status.trim() && !patch.trim() ? (
        <InspectorEmpty
          icon={GitCompareArrows}
          title="Working tree is clean"
          detail="Changes made by the worker will appear here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {diff?.status.trim() ? (
            <pre className="border-b border-[#24272d] px-3 py-2 font-mono text-[11px] leading-5 text-[#aeb4bd]">
              {diff.status}
            </pre>
          ) : null}
          <pre className="min-w-max px-3 py-3 font-mono text-[11px] leading-[1.65] text-[#b8bec7]">
            {patch.split("\n").map((line, index) => (
              <span
                key={`${index}-${line}`}
                className={`block ${
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "bg-[#183523]/55 text-[#75d291]"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "bg-[#3b2024]/55 text-[#ef8a92]"
                      : line.startsWith("@@")
                        ? "text-[#7fa7ff]"
                        : ""
                }`}
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

function BrowserView({
  api,
  sessionId,
  requestedAddress,
}: {
  api: CloudAPI;
  sessionId: string;
  requestedAddress?: string;
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
        const response = await api.workspacePreviewTicket(sessionId, parsed.port);
        setPreviewURL(
          `${response.url}${parsed.pathname.replace(/^\/+/, "")}${parsed.search}`,
        );
        setLoadedAddress(parsed.href);
        setAddress(parsed.href);
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
    [api, sessionId],
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
          className="grid size-6 place-items-center rounded text-[#89909b] hover:bg-[#24272d] hover:text-[#e3e6ea]"
          aria-label="Reload preview"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Preview address"
          className="h-7 min-w-0 flex-1 rounded-md border border-[#2a2e35] bg-[#181b20] px-2.5 font-mono text-[11px] text-[#d4d7dc] outline-none placeholder:text-[#636a74] focus:border-[#4d75c9]"
          placeholder="http://localhost:3000"
        />
      </form>
      <div className="min-h-0 flex-1">
        {error ? (
          <InspectorError message={error} />
        ) : !previewURL ? (
          <InspectorEmpty
            icon={Globe2}
            title="Open a worker preview"
            detail="Start a server in the terminal, then enter its localhost URL above."
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

function FilesView({ api, sessionId }: { api: CloudAPI; sessionId: string }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<CloudWorkspaceEntry[]>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDirectory = useCallback(
    async (target: string) => {
      setLoading(true);
      setError("");
      setFile(null);
      try {
        const response = await api.workspaceFiles(sessionId, target);
        setPath(response.path === "." ? "" : response.path);
        setEntries(
          [...response.entries].sort(
            (left, right) =>
              Number(right.isDir) - Number(left.isDir) ||
              left.name.localeCompare(right.name),
          ),
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Could not load files.");
      } finally {
        setLoading(false);
      }
    },
    [api, sessionId],
  );

  useEffect(() => void loadDirectory(""), [loadDirectory]);

  const openFile = async (entry: CloudWorkspaceEntry) => {
    if (entry.isDir) {
      await loadDirectory(entry.path);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await api.workspaceFile(sessionId, entry.path);
      setFile(response);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not open file.");
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
}: {
  label: string;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  back?: () => void;
}) {
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
      <button
        type="button"
        onClick={() => void onRefresh()}
        className="grid size-6 place-items-center rounded text-[#858c96] hover:bg-[#24272d] hover:text-[#e5e7eb]"
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
        <Icon className="mx-auto mb-3 size-5 text-[#555d68]" strokeWidth={1.5} />
        <p className="text-xs text-[#bdc2ca]">{title}</p>
        <p className="mt-1 max-w-56 text-[11px] leading-5 text-[#6f7681]">{detail}</p>
      </div>
    </div>
  );
}

function parsePreviewAddress(value: string) {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`;
  const parsed = new URL(withProtocol);
  if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) {
    throw new Error("Preview URLs must use localhost, 127.0.0.1, or 0.0.0.0.");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (port < 1024 || port > 65535) {
    throw new Error("Use a localhost port between 1024 and 65535.");
  }
  return {
    port,
    pathname: parsed.pathname,
    search: parsed.search,
    href: `http://localhost:${port}${parsed.pathname}${parsed.search}`,
  };
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
