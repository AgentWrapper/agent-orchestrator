// Stub - code block component for blog posts
import * as React from "react";

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  children?: React.ReactNode;
}

export function CodeBlock({ code, language, showLineNumbers, children }: CodeBlockProps) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-4 text-sm">
      <code>{code}</code>
      {children}
    </pre>
  );
}

export function CodeBlockCopyButton() {
  return null;
}
