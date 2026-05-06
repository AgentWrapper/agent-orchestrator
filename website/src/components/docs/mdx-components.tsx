/**
 * Shared MDX component registry for docs pages.
 * Exposes docs-specific components and a small Accordion pair used by content.
 */
import type { ReactNode } from "react";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Logo } from "./Logo";
import { PlatformSupport } from "./PlatformSupport";
import { PluginCard, PluginGrid } from "./PluginCard";

function Accordions({ children }: { children: ReactNode }) {
  return <div className="my-6 space-y-3">{children}</div>;
}

function Accordion({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-4 py-3">
      <summary className="cursor-pointer list-none text-sm font-medium text-[var(--color-text-primary)]">
        {title}
      </summary>
      <div className="mt-3 text-sm text-[var(--color-text-secondary)]">{children}</div>
    </details>
  );
}

export function getMDXComponents(): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Logo,
    PlatformSupport,
    PluginCard,
    PluginGrid,
  };
}