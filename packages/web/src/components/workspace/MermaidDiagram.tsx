"use client";

import { useState, useEffect, useRef } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "strict",
});

let idCounter = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string>("");

  if (!idRef.current) {
    idRef.current = `mermaid-diagram-${idCounter++}`;
  }

  useEffect(() => {
    let cancelled = false;

    mermaid
      .render(idRef.current, code)
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-error">
        <strong>Mermaid syntax error</strong>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!svg) return null;

  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
