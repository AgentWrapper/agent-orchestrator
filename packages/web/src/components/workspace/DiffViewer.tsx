"use client";

import { useFileView, type DiffFileData } from "./useFileView";
import { parseUnifiedDiff, syntheticUntrackedHunks, type DiffHunk, type DiffLine } from "./diffParse";
import { highlightDiffLine, languageForFilePath } from "./codeHighlight";

type DiffScope = "local" | "branch";

interface DiffViewerProps {
  sessionId: string;
  selectedFile: string | null;
  scope?: DiffScope;
  baseRef?: string | null;
}

function buildHunks(data: DiffFileData): DiffHunk[] {
  if (typeof data.diff === "string" && data.diff.length > 0) {
    return parseUnifiedDiff(data.diff);
  }
  if (typeof data.content === "string") {
    return syntheticUntrackedHunks(data.content);
  }
  return [];
}

function EmptyState() {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">📄</span>
      <p>Select a changed file to view diff</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">🚫</span>
      <p>{message}</p>
    </div>
  );
}

function DiffLineContent({ line, languageId }: { line: DiffLine; languageId: string | undefined }) {
  if (languageId && line.content.length > 0) {
    const html = highlightDiffLine(line.content, languageId);
    if (html !== null) {
      return (
        <span className="workspace-diff-content" dangerouslySetInnerHTML={{ __html: html }} />
      );
    }
  }
  return <span className="workspace-diff-content">{line.content}</span>;
}

function LoadingSkeleton({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-2">
        <span className="font-mono text-[12px] text-[var(--color-text-secondary)]">
          {path}
        </span>
      </div>
      <div className="flex-1 p-4">
        <div className="space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div
                className="h-3 w-6 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                style={{ animationDelay: `${i * 50}ms` }}
              />
              <div
                className="h-3 w-4 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                style={{ animationDelay: `${i * 50}ms` }}
              />
              <div
                className="h-3 animate-pulse rounded bg-[var(--color-border-subtle)]"
                style={{
                  animationDelay: `${i * 50}ms`,
                  width: `${25 + Math.abs(Math.sin(i * 1.3)) * 50}%`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DiffViewer({ sessionId, selectedFile, scope = "local", baseRef }: DiffViewerProps) {
  const { data, error, loading } = useFileView(sessionId, selectedFile, "diff", scope);
  // When scope=branch but no base can be resolved, the backend falls back to
  // HEAD-based diff. Surface that honestly instead of the misleading "vs base".
  // Strip "origin/" so the label reads like GitHub ("vs main" not "vs origin/main").
  const scopeLabel =
    scope === "branch" && baseRef
      ? `vs ${baseRef.replace(/^origin\//, "")}`
      : "vs HEAD";

  if (!selectedFile) {
    return <EmptyState />;
  }

  // Stale guard: data from a previous path should show skeleton, not old content
  const stale = data && data.kind === "diff" && data.path !== selectedFile;

  if (loading || stale) {
    return <LoadingSkeleton path={selectedFile} />;
  }

  if (error) {
    return <ErrorState message={error.message} />;
  }

  if (!data || data.kind !== "diff") {
    return <EmptyState />;
  }

  const hunks = buildHunks(data);
  const languageId = languageForFilePath(selectedFile);

  if (hunks.length === 0) {
    return (
      <div className="workspace-empty-state">
        <span className="workspace-empty-icon">✓</span>
        <p>No changes</p>
      </div>
    );
  }

  return (
    <div>
      <div className="workspace-diff-scope-label">{scopeLabel}</div>
    <pre className="workspace-diff-viewer">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="workspace-diff-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, j) => (
            <div key={j} className={`workspace-diff-line workspace-diff-line--${line.type}`}>
              <span className="workspace-diff-gutter workspace-diff-gutter--old">
                {line.oldLineNumber ?? ""}
              </span>
              <span className="workspace-diff-gutter workspace-diff-gutter--new">
                {line.newLineNumber ?? ""}
              </span>
              <span className="workspace-diff-marker">
                {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
              </span>
              <DiffLineContent line={line} languageId={languageId} />
            </div>
          ))}
        </div>
      ))}
    </pre>
    </div>
  );
}
