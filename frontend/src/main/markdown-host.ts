import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import { renderMarkdown, extractTitle } from "./markdown-renderer";
import type {
  MarkdownDocument,
  MarkdownSource,
  RenderMarkdownRequest,
  RenderMarkdownResponse,
  MarkdownUpdateEvent,
} from "../shared/markdown-types";
import { MarkdownIpcChannels } from "../shared/markdown-types";

type MainWindowLike = {
  webContents: { send: (channel: string, ...args: unknown[]) => void };
};

export function mdPreviewUrl(documentId: string): string {
  return `app://md-preview/${encodeURIComponent(documentId)}`;
}

export class MarkdownHost {
  private mainWindow: MainWindowLike;
  private documents = new Map<string, MarkdownDocument>();
  private seqCounter = 0;
  private watchers = new Map<string, FSWatcher>();
  private docFiles = new Map<string, Set<string>>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(mainWindow: MainWindowLike) {
    this.mainWindow = mainWindow;
  }

  async render(request: RenderMarkdownRequest): Promise<RenderMarkdownResponse> {
    this.ensureNotDisposed();

    let source = request.source;

    if (source.kind === "file") {
      const content = await readFile(source.path, "utf-8");
      const doc = await this.createDocument(request.sessionId, source, content);
      this.ensureWatcher(doc);
      return docToResponse(doc);
    }

    if (source.kind === "virtual") {
      const doc = await this.createDocument(request.sessionId, source, source.content);
      return docToResponse(doc);
    }

    if (source.kind === "url") {
      const localPath = resolveLocalPath(source.url, request.workspacePath);
      if (localPath) {
        const content = await readFile(localPath, "utf-8");
        const doc = await this.createDocument(request.sessionId, { kind: "file", path: localPath }, content);
        this.ensureWatcher(doc);
        return docToResponse(doc);
      }
      // Fallback: try the URL as a direct filesystem path.
      // Catches edge cases like UNC paths on platforms where fileURLToPath
      // produces a path that existsSync rejects, or paths the BrowserPanel
      // normalizer didn't convert to file://.
      const fsPath = tryLocalFile(source.url);
      if (fsPath) {
        const content = await readFile(fsPath, "utf-8");
        const doc = await this.createDocument(request.sessionId, { kind: "file", path: fsPath }, content);
        this.ensureWatcher(doc);
        return docToResponse(doc);
      }
      // Don't let file:// URLs reach fetch — it only supports http:/https:.
      if (source.url.startsWith("file://")) {
        throw new Error(`File not found: ${source.url}`);
      }
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch markdown from ${source.url}: ${response.status}`);
      }
      const content = await response.text();
      const doc = await this.createDocument(request.sessionId, source, content);
      return docToResponse(doc);
    }

    throw new Error(`Unsupported markdown source kind: ${(source as { kind: string }).kind}`);
  }

  destroy(documentId: string): void {
    this.documents.delete(documentId);
    this.removeFileWatchersForDoc(documentId);
  }

  destroySession(sessionId: string): void {
    for (const [docId, doc] of this.documents) {
      if (doc.sessionId === sessionId) {
        this.destroy(docId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.docFiles.clear();
    this.documents.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  getCachedHtml(documentId: string): string | null {
    const doc = this.documents.get(documentId);
    return doc?.renderedHtml ?? null;
  }

  private ensureNotDisposed(): void {
    if (this.disposed) throw new Error("MarkdownHost has been disposed");
  }

  private async createDocument(
    sessionId: string,
    source: MarkdownSource,
    content: string,
  ): Promise<MarkdownDocument> {
    const renderedHtml = renderMarkdown(content);
    const title = extractTitle(renderedHtml)
      ?? (source.kind === "file" ? path.basename(source.path) : "Markdown Preview");

    const sourceKey = sourceKeyOf(source);
    for (const doc of this.documents.values()) {
      if (doc.sessionId === sessionId && sourceKeyOf(doc.source) === sourceKey) {
        doc.renderedHtml = renderedHtml;
        doc.title = title;
        doc.revision++;
        doc.updatedAt = Date.now();
        this.documents.set(doc.id, doc);
        this.mainWindow.webContents.send(MarkdownIpcChannels.stateChanged, {
          documentId: doc.id,
          revision: doc.revision,
          needsReload: true,
          title,
        } satisfies MarkdownUpdateEvent);
        return doc;
      }
    }

    this.seqCounter++;
    const id = `md://${sessionId}/${this.seqCounter}`;
    const now = Date.now();
    const doc: MarkdownDocument = {
      id,
      sessionId,
      source,
      renderedHtml,
      title,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.documents.set(id, doc);
    return doc;
  }

  private ensureWatcher(doc: MarkdownDocument): void {
    if (doc.source.kind !== "file") return;

    const filePath = path.resolve(doc.source.path);

    let files = this.docFiles.get(doc.id);
    if (!files) {
      files = new Set();
      this.docFiles.set(doc.id, files);
    }
    if (files.has(filePath)) return;
    files.add(filePath);

    if (this.watchers.has(filePath)) return;

    const watcher = chokidar.watch(filePath, {
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignoreInitial: true,
      followSymlinks: false,
    });

    watcher.on("change", () => this.onFileChanged(filePath));
    watcher.on("unlink", () => this.onFileDeleted(filePath));
    watcher.on("error", (err: unknown) => {
      console.error(`[md-host] Watcher error for ${filePath}:`, err);
    });

    this.watchers.set(filePath, watcher);
  }

  private onFileChanged(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath);

      for (const [docId, files] of this.docFiles) {
        if (!files.has(filePath)) continue;

        const doc = this.documents.get(docId);
        if (!doc) continue;

        try {
          const content = await readFile(filePath, "utf-8");
          const renderedHtml = renderMarkdown(content, doc.title);
          const title = extractTitle(renderedHtml) ?? doc.title;
          doc.renderedHtml = renderedHtml;
          doc.title = title;
          doc.revision++;
          doc.updatedAt = Date.now();
          this.documents.set(docId, doc);

          this.mainWindow.webContents.send(MarkdownIpcChannels.fileChanged, {
            documentId: docId,
            revision: doc.revision,
            needsReload: true,
            title,
          } satisfies MarkdownUpdateEvent);
        } catch (err) {
          console.error(`[md-host] Failed to re-render ${filePath}:`, err);
        }
      }
    }, 300);

    this.debounceTimers.set(filePath, timer);
  }

  private onFileDeleted(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);

      for (const [docId, files] of this.docFiles) {
        if (!files.has(filePath)) continue;

        const doc = this.documents.get(docId);
        if (!doc) continue;

        const deletedHtml = renderMarkdown(
          `> **File deleted** — \`${path.basename(filePath)}\` was removed from disk.\n>\n> The browser panel will not update again for this document.`,
        );
        doc.renderedHtml = deletedHtml;
        doc.revision++;
        doc.updatedAt = Date.now();
        this.documents.set(docId, doc);

        this.mainWindow.webContents.send(MarkdownIpcChannels.fileChanged, {
          documentId: docId,
          revision: doc.revision,
          needsReload: true,
          title: `(removed) ${path.basename(filePath)}`,
        } satisfies MarkdownUpdateEvent);
      }

      const watcher = this.watchers.get(filePath);
      if (watcher) {
        watcher.close();
        this.watchers.delete(filePath);
      }
    }, 300);

    this.debounceTimers.set(filePath, timer);
  }

  private removeFileWatchersForDoc(documentId: string): void {
    const files = this.docFiles.get(documentId);
    if (!files) return;

    for (const filePath of files) {
      const watcher = this.watchers.get(filePath);
      if (watcher) {
        watcher.close();
        this.watchers.delete(filePath);
      }
      const timer = this.debounceTimers.get(filePath);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(filePath);
      }
    }
    this.docFiles.delete(documentId);
  }
}

function docToResponse(doc: MarkdownDocument): RenderMarkdownResponse {
  return {
    documentId: doc.id,
    url: `app://md-preview/${encodeURIComponent(doc.id)}`,
    title: doc.title,
    revision: doc.revision,
  };
}

function sourceKeyOf(source: MarkdownSource): string {
  switch (source.kind) {
    case "file":
      return `file:${path.resolve(source.path)}`;
    case "virtual":
      return `vhash:${hashCode(source.content)}`;
    case "url":
      return `url:${source.url}`;
  }
}

function hashCode(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

const DAEMON_PROXY_RE = /\/api\/v1\/sessions\/[^/]+\/preview\/files\/(.+)$/i;

function parseDaemonProxyEntry(url: string): string | null {
  const m = DAEMON_PROXY_RE.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function tryLocalFile(url: string): string | null {
  // Skip network URLs — let the fetch path handle those.
  if (/^https?:\/\//i.test(url)) return null;
  // Normalize backslashes to forward slashes and strip any file:// prefix.
  const normalized = url.replace(/\\/g, "/").replace(/^file:\/\//i, "");
  if (existsSync(normalized)) return normalized;
  return null;
}

function resolveLocalPath(url: string, workspacePath?: string): string | null {
  let p: string;
  if (url.startsWith("file://")) {
    p = fileURLToPath(url);
  } else if (url.startsWith("/")) {
    p = url;
  } else if (workspacePath) {
    const entry = parseDaemonProxyEntry(url);
    if (!entry) return null;
    p = path.join(workspacePath, entry);
    // Prevent directory traversal outside the workspace path.
    if (!p.startsWith(workspacePath + path.sep) && p !== workspacePath) return null;
  } else {
    return null;
  }
  if (existsSync(p) && !p.endsWith("/")) {
    return p;
  }
  return null;
}
