/**
 * Catalog-style card for a single plugin.
 * Used on the plugin overview pages to let users scan by logo + one-liner.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./Logo";

export interface PluginCardProps {
  name: string;
  logo: string;
  href: string;
  description: string;
  badge?: ReactNode;
}

export function PluginCard({ name, logo, href, description, badge }: PluginCardProps) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.875rem",
        padding: "1rem",
        borderRadius: "0.5rem",
        border: "1px solid var(--color-fd-border)",
        backgroundColor: "var(--color-fd-card)",
        textDecoration: "none",
        transition: "border-color 150ms, transform 150ms",
      }}
      className="ao-plugin-card"
    >
      <span
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "0.375rem",
          backgroundColor: "var(--color-fd-muted)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-fd-foreground)",
          flexShrink: 0,
        }}
      >
        <Logo name={logo} size={22} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: "0.25rem", minWidth: 0 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.5rem",
            fontSize: "0.9375rem",
            fontWeight: 600,
            color: "var(--color-fd-foreground)",
            margin: 0,
          }}
        >
          {name}
          {badge}
        </span>
        <span
          style={{
            fontSize: "0.8125rem",
            color: "var(--color-fd-muted-foreground)",
            lineHeight: 1.45,
          }}
        >
          {description}
        </span>
      </span>
    </Link>
  );
}

export function PluginGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "0.75rem",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        margin: "1.25rem 0",
      }}
    >
      {children}
    </div>
  );
}
