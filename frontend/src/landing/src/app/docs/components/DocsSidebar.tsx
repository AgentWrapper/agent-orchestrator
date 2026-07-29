"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { DocsNavItem } from "@/lib/docs";

const GROUP_TRANSITION_MS = 180;

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

function isPathActive(url: string | undefined, pathname: string): boolean {
  if (!url) return false;
  return normalizePath(url) === normalizePath(pathname);
}

function itemContainsPath(item: DocsNavItem, pathname: string): boolean {
  if (isPathActive(item.url, pathname)) return true;
  return item.items?.some((child) => itemContainsPath(child, pathname)) ?? false;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function getItemOffset(depth: number): string {
  return `calc(${2 + 3 * depth} * 0.25rem)`;
}

function NavLink({
  item,
  depth,
  currentPath,
  onNavigate,
}: {
  item: DocsNavItem;
  depth: number;
  currentPath: string;
  onNavigate: (url: string) => void;
}) {
  const active = isPathActive(item.url, currentPath);
  const hasChildren = Boolean(item.items && item.items.length > 0);
  const inActiveChain = itemContainsPath(item, currentPath);
  const containsActiveChild =
    hasChildren && (item.items?.some((child) => itemContainsPath(child, currentPath)) ?? false);
  const [open, setOpen] = useState(inActiveChain);
  const [interactionLocked, setInteractionLocked] = useState(false);
  const unlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (inActiveChain) {
      setOpen(true);
    }
  }, [inActiveChain]);

  useEffect(() => {
    return () => {
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
      }
    };
  }, []);

  // Section label ("Getting Started") — the top grouping level.
  if (item.separator) {
    return (
      <div
        className="mt-7 mb-2 px-3 text-sm font-medium text-muted-foreground/55 first:mt-0"
        style={{ paddingInlineStart: getItemOffset(depth) }}
      >
        {item.title}
      </div>
    );
  }

  const groupHeader = hasChildren;
  const base =
    "relative flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98]";
  const tone = active
    ? "bg-muted text-foreground"
    : inActiveChain
      ? "bg-muted/50 text-foreground"
    : groupHeader
      ? "font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground";
  const itemUrl = item.url;

  function lockInteractions() {
    setInteractionLocked(true);
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
    }
    unlockTimerRef.current = setTimeout(() => {
      setInteractionLocked(false);
      unlockTimerRef.current = null;
    }, GROUP_TRANSITION_MS);
  }

  function setOpenLocked(nextOpen: boolean) {
    lockInteractions();
    setOpen(nextOpen);
  }

  return (
    <div>
      {hasChildren ? (
        <div className="relative rounded-lg">
          {itemUrl ? (
            <Link
              href={itemUrl}
              onClick={(event) => {
                if (interactionLocked) {
                  event.preventDefault();
                  return;
                }

                if (active) {
                  event.preventDefault();
                  setOpenLocked(false);
                  return;
                }

                onNavigate(itemUrl);
                setOpenLocked(!containsActiveChild);
              }}
              className={`${base} ${tone} min-w-0 w-full pe-10`}
              style={{ paddingInlineStart: getItemOffset(depth) }}
              aria-disabled={interactionLocked}
            >
              <span className="min-w-0 flex-1">{item.title}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (interactionLocked) return;
                setOpenLocked(!open);
              }}
              className={`${base} w-full text-muted-foreground hover:text-foreground`}
              style={{ paddingInlineStart: getItemOffset(depth) }}
              disabled={interactionLocked}
            >
              <span className="min-w-0 flex-1 text-start">{item.title}</span>
            </button>
          )}
          <button
            type="button"
            aria-label={open ? `Collapse ${item.title}` : `Expand ${item.title}`}
            aria-expanded={open}
            onClick={() => {
              if (interactionLocked) return;
              setOpenLocked(!open);
            }}
            className="absolute inset-y-0 end-1 inline-flex size-9 items-center justify-center self-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/60 hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-60"
            disabled={interactionLocked}
          >
            <Chevron open={open} />
          </button>
        </div>
      ) : itemUrl ? (
        <Link
          href={itemUrl}
          onClick={() => onNavigate(itemUrl)}
          className={`${base} ${tone}`}
          style={{ paddingInlineStart: getItemOffset(depth) }}
        >
          {item.title}
        </Link>
      ) : (
        <div className="px-3 py-2.5 text-sm font-medium text-foreground">{item.title}</div>
      )}
      <AnimatePresence initial={false}>
        {hasChildren && open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
              opacity: { duration: 0.14, ease: "easeOut" },
            }}
            className="overflow-hidden will-change-[height,opacity]"
          >
            <div className="mt-1 flex flex-col gap-1 pt-0.5">
              {item.items?.map((child) => (
                <NavLink
                  key={child.title + (child.url ?? "")}
                  item={child}
                  depth={depth + 1}
                  currentPath={currentPath}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function DocsSidebar({ nav }: { nav: DocsNavItem[] }) {
  const pathname = usePathname();
  const [optimisticPath, setOptimisticPath] = useState<string | null>(null);
  const currentPath = optimisticPath ?? pathname;

  useEffect(() => {
    setOptimisticPath(null);
  }, [pathname]);

  return (
    <nav aria-label="Docs" className="flex flex-col gap-0.5 select-none">
      {nav.map((item) => (
        <NavLink
          key={item.title + (item.url ?? "")}
          item={item}
          depth={0}
          currentPath={currentPath}
          onNavigate={setOptimisticPath}
        />
      ))}
    </nav>
  );
}
