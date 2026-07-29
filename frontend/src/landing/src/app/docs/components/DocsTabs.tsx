"use client";

import { Children, isValidElement, type ReactElement, type ReactNode, useState } from "react";

interface TabProps {
  value: string;
  children: ReactNode;
}

export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

export function Tabs({ items, children }: { items?: string[]; children: ReactNode }) {
  const [active, setActive] = useState(0);
  const tabs = Children.toArray(children).filter((c): c is ReactElement<TabProps> => isValidElement(c));
  const labels = items ?? tabs.map((t, i) => t.props.value ?? `Tab ${i + 1}`);

  return (
    <div className="my-6 overflow-hidden rounded-xl border border-border bg-muted/25">
      <div className="flex flex-wrap gap-1 border-b border-border bg-background p-1.5">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => setActive(i)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              i === active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="prose prose-invert max-w-none px-4 py-4 prose-p:my-2 prose-pre:my-2">
        {tabs[active]?.props.children}
      </div>
    </div>
  );
}
