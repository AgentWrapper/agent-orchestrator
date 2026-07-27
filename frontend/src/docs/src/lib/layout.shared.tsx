import { BookOpenText } from "lucide-react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { COMPANY } from "@superset/shared/constants";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      url: "/docs",
      title: (
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-muted/40 text-foreground">
            <BookOpenText className="size-4" />
          </span>
          <span>{COMPANY.NAME} Docs</span>
        </span>
      ),
    },
    themeSwitch: {
      enabled: false,
    },
    links: [
      {
        text: "Main site",
        url: COMPANY.MARKETING_URL,
      },
      {
        text: "GitHub",
        url: COMPANY.GITHUB_URL,
      },
    ],
  };
}
