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
    <div className="my-6 overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap gap-1 border-b border-border bg-surface/50 p-1">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => setActive(i)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              i === active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="prose prose-invert max-w-none px-4 py-3 prose-p:my-2 prose-pre:my-2">
        {tabs[active]?.props.children}
      </div>
    </div>
  );
}
