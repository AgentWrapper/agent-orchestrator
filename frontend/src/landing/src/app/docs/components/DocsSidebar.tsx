"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocsNavItem } from "@/lib/docs";

function NavLink({ item, depth }: { item: DocsNavItem; depth: number }) {
  const pathname = usePathname();
  const active = item.url === pathname;
  const hasChildren = Boolean(item.items && item.items.length > 0);

  // Section label ("Getting Started") — the top grouping level.
  if (item.separator) {
    return (
      <div className="mt-7 mb-2 px-2 text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground/70 first:mt-0">
        {item.title}
      </div>
    );
  }

  // A main topic that owns child pages reads as a group header (stronger weight,
  // foreground colour, extra spacing above); leaf pages read lighter.
  const groupHeader = hasChildren;
  const base = "block rounded-md px-2 py-1.5 text-sm transition-colors";
  const tone = active
    ? "bg-surface font-medium text-foreground"
    : groupHeader
      ? "font-medium text-foreground hover:bg-surface/50"
      : "text-muted-foreground hover:text-foreground";

  const label = item.url ? (
    <Link href={item.url} className={`${base} ${tone}`}>
      {item.title}
    </Link>
  ) : (
    <div className="px-2 py-1.5 text-sm font-medium text-foreground">{item.title}</div>
  );

  return (
    <div className={groupHeader && depth > 0 ? "mt-3" : undefined}>
      {label}
      {hasChildren && (
        <div className="mt-0.5 ml-2.5 flex flex-col gap-0.5 border-l border-border pl-2">
          {item.items?.map((child) => (
            <NavLink key={child.title + (child.url ?? "")} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocsSidebar({ nav }: { nav: DocsNavItem[] }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-0.5">
      {nav.map((item) => (
        <NavLink key={item.title + (item.url ?? "")} item={item} depth={0} />
      ))}
    </nav>
  );
}
