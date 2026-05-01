"use client";

import { Children, isValidElement, useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}

function findCodeChild(children: ReactNode): ReactElement<CodeElementProps> | null {
  for (const child of Children.toArray(children)) {
    if (isValidElement<CodeElementProps>(child) && child.type === "code") {
      return child;
    }
  }
  return null;
}

function languageFromClassName(className: string | undefined): string | null {
  if (!className) return null;
  for (const cls of className.split(/\s+/)) {
    if (cls.startsWith("language-")) {
      return cls.slice("language-".length) || null;
    }
  }
  return null;
}

interface CodeBlockProps {
  children?: ReactNode;
}

export function CodeBlock({ children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const codeChild = findCodeChild(children);
  const language = languageFromClassName(codeChild?.props.className);

  // Mermaid short-circuits here — the `code` component override handles rendering
  if (language === "mermaid") {
    return <>{children}</>;
  }

  const rawText = codeChild ? extractText(codeChild.props.children) : extractText(children);
  const displayLang = language ?? "text";

  const handleCopy = useCallback(async () => {
    const text = rawText.replace(/\n$/, "");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // swallow
    }
  }, [rawText]);

  return (
    <div className="workspace-md-code-block">
      <div className="workspace-md-code-block-header">
        <span className="workspace-md-code-block-lang">{displayLang}</span>
        <button
          type="button"
          onClick={handleCopy}
          className={`workspace-md-code-block-copy ${copied ? "workspace-md-code-block-copy--copied" : ""}`}
          aria-label="Copy code to clipboard"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
