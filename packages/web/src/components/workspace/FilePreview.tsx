"use client";

import dynamic from "next/dynamic";
import { memo, useMemo } from "react";
import { useFileView } from "./useFileView";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { highlightFileContentByLines, languageForFilePath } from "./codeHighlight";
import { CodeBlock } from "./CodeBlock";

const MermaidDiagram = dynamic(
  () => import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })),
  { ssr: false }
);

// Defined at module scope so the reference is stable across renders.
// A new function reference inside the component would cause react-markdown
// to unmount/remount MermaidDiagram on every render, resetting SVG state.
const markdownComponents = {
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<"code">) {
    if (className?.split(" ").includes("language-mermaid")) {
      return <MermaidDiagram code={String(children).trim()} />;
    }
    return <code className={className} {...props}>{children}</code>;
  },
  pre({ children }: React.ComponentPropsWithoutRef<"pre">) {
    return <CodeBlock>{children}</CodeBlock>;
  },
};

interface FilePreviewProps {
  sessionId: string;
  selectedFile: string | null;
}

const CodeViewer = memo(function CodeViewer({ content, fileName }: { content: string; fileName: string }) {
  const lines = content.split("\n");
  const gutterWidth = String(lines.length).length;
  const lang = languageForFilePath(fileName);
  const highlightedLines = useMemo(
    () => (lang ? highlightFileContentByLines(content, lang) : null),
    [content, lang],
  );

  return (
    <pre className="workspace-code-viewer">
      {lines.map((line, i) => (
        <div key={i} className="workspace-code-line">
          <span className="workspace-code-gutter">{String(i + 1).padStart(gutterWidth)}</span>
          {highlightedLines ? (
            <span
              className="workspace-code-content"
              dangerouslySetInnerHTML={{ __html: highlightedLines[i] ?? "" }}
            />
          ) : (
            <span className="workspace-code-content">{line}</span>
          )}
        </div>
      ))}
    </pre>
  );
});

function UnsupportedPreview({ message, size }: { error: string; message: string; size: number }) {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">🚫</span>
      <p>{message}</p>
      {size > 0 && (
        <p style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>
          ({(size / 1024 / 1024).toFixed(1)} MB)
        </p>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">📄</span>
      <p>Select a file from the tree to preview</p>
    </div>
  );
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
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div
                className="h-3 w-8 shrink-0 animate-pulse rounded bg-[var(--color-border-subtle)]"
                style={{ animationDelay: `${i * 50}ms` }}
              />
              <div
                className="h-3 animate-pulse rounded bg-[var(--color-border-subtle)]"
                style={{
                  animationDelay: `${i * 50}ms`,
                  width: `${30 + Math.abs(Math.sin(i * 1.5)) * 55}%`,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function FilePreview({ sessionId, selectedFile }: FilePreviewProps) {
  const { data, error, loading } = useFileView(sessionId, selectedFile, "raw");

  if (!selectedFile) {
    return <EmptyState />;
  }

  // Stale guard: data from a previous path should show skeleton, not old content
  const stale = data && data.kind === "raw" && data.path !== selectedFile;

  if (loading || stale) {
    return <LoadingSkeleton path={selectedFile} />;
  }

  if (error) {
    return (
      <UnsupportedPreview
        error={error.error}
        message={error.message}
        size={error.size ?? 0}
      />
    );
  }

  if (!data || data.kind !== "raw") {
    return <EmptyState />;
  }

  const isMarkdown = data.path.endsWith(".md") || data.path.endsWith(".mdx");

  return (
    <>
      {isMarkdown ? (
        <div className="workspace-markdown-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={markdownComponents}
          >
            {data.content}
          </ReactMarkdown>
        </div>
      ) : (
        <CodeViewer content={data.content} fileName={data.path} />
      )}
    </>
  );
}
