"use client";

import { COMPANY, HERO_SUBHEADLINE, TAGLINE } from "@superset/shared/constants";
import { useState } from "react";
import { FaGithub } from "react-icons/fa";
import { isMacPlatform, usePlatform } from "../../hooks/useOS";
import { DownloadButton } from "../DownloadButton";
import { ProductDemo } from "./components/ProductDemo";

const INSTALL_COMMAND = "brew install agentwrapper/tap/agent-orchestrator";
// Wraps at the path separators instead of mid-word once the pill goes two-line.
const INSTALL_COMMAND_PARTS = INSTALL_COMMAND.split("/");

function formatStarCount(count: number) {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }

  return count.toString();
}

interface HeroSectionProps {
  initialStars: number | null;
}

export function HeroSection({ initialStars }: HeroSectionProps) {
  const [copiedCommand, setCopiedCommand] = useState(false);
  const { platform } = usePlatform();
  const showInstallCommand = isMacPlatform(platform);

  const githubButtonLabel =
    initialStars === null
      ? "Stars on GitHub"
      : `${formatStarCount(initialStars)} Stars on GitHub`;

  const copyInstallCommand = async () => {
    if (!navigator.clipboard) return;

    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1600);
  };

  return (
    <div className="relative">
      <div className="relative flex flex-col items-center overflow-hidden pt-24 pb-8 sm:pt-32 sm:pb-10 lg:pt-36 lg:pb-12">
        <div className="relative w-full max-w-[1600px] mx-auto px-4 sm:px-8 lg:px-[30px]">
          <div className="flex flex-col items-center text-center">
            <div className="space-y-5 sm:space-y-7 select-none">
              <h1 className="font-sans text-4xl sm:text-5xl md:text-6xl lg:text-[4.75rem] font-normal tracking-[-0.5px] leading-[0.98] text-foreground max-w-6xl mx-auto text-balance">
                {TAGLINE}
              </h1>
              <p
                id="hero-subheadline"
                className="text-base sm:text-xl font-normal leading-8 text-muted-foreground max-w-4xl mx-auto text-balance"
              >
                {HERO_SUBHEADLINE}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4 mt-6 sm:mt-8">
              <DownloadButton className="rounded-3xl" />
              <button
                type="button"
                className="px-4 py-2.5 sm:px-6 sm:py-3 rounded-3xl text-sm sm:text-base tracking-[-0.5px] font-normal bg-background border border-border text-foreground hover:bg-muted transition-colors flex items-center gap-2"
                onClick={() => window.open(COMPANY.GITHUB_URL, "_blank")}
                aria-label={githubButtonLabel}
              >
                {githubButtonLabel}
                <FaGithub className="size-4" />
              </button>
            </div>

            {showInstallCommand ? (
              <button
                type="button"
                aria-label={`Copy brew install command: ${INSTALL_COMMAND}`}
                title="Click to copy"
                className="group mt-4 flex min-h-11 w-full max-w-xl items-start gap-2 rounded-3xl border border-border bg-card/70 px-3 py-2.5 text-left font-mono text-xs tracking-[0.5px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:w-auto sm:items-center sm:overflow-hidden sm:text-sm"
                onClick={copyInstallCommand}
              >
                <span className="text-foreground/40" aria-hidden="true">
                  $
                </span>
                <code className="min-w-0 flex-1 break-words whitespace-normal text-foreground/80 sm:flex-none sm:truncate sm:whitespace-nowrap">
                  {INSTALL_COMMAND_PARTS.map((part, index) => (
                    <span key={part}>
                      {index > 0 ? "/" : null}
                      {part}
                      {index < INSTALL_COMMAND_PARTS.length - 1 ? <wbr /> : null}
                    </span>
                  ))}
                </code>
                <span
                  className="ml-2 inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground"
                  aria-hidden="true"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <rect x="9" y="9" width="12" height="12" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                  {copiedCommand ? "Copied" : "Copy"}
                </span>
              </button>
            ) : null}
          </div>

          <div className="relative w-full max-w-7xl mx-auto mt-12 sm:mt-16 lg:mt-20">
            <ProductDemo />
          </div>
        </div>
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[100px]"
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0) 0%, var(--background) 100%)",
        }}
      />
    </div>
  );
}
