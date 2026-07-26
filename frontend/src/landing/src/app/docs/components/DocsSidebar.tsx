"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocsNavItem } from "@/lib/docs";

function NavLink({ item, depth }: { item: DocsNavItem; depth: number }) {
  const pathname = usePathname();
  const active = item.url === pathname;
  const pad = depth === 0 ? "" : depth === 1 ? "pl-3" : "pl-6";

  if (item.separator) {
    return (
      <div className="mt-6 mb-2 px-2 text-xs font-semibold uppercase tracking-[0.5px] text-muted-foreground first:mt-0">
        {item.title}
      </div>
    );
  }

  return (
    <div>
      {item.url ? (
        <Link
          href={item.url}
          className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${pad} ${
            active
              ? "bg-surface font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {item.title}
        </Link>
      ) : (
        <div className={`px-2 py-1.5 text-sm font-medium text-foreground ${pad}`}>{item.title}</div>
      )}
      {item.items && item.items.length > 0 && (
        <div className="mt-0.5">
          {item.items.map((child) => (
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
