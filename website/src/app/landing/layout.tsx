import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Orchestrator",
  description:
    "Open-source platform for running parallel AI coding agents. Spawn Claude Code, Codex, Aider, and more in isolated worktrees — all managed from one dashboard.",
  openGraph: {
    type: "website",
    url: "https://aoagents.dev/landing",
    siteName: "Agent Orchestrator",
    title: "Agent Orchestrator",
    description:
      "Open-source platform for running parallel AI coding agents. Spawn Claude Code, Codex, Aider, and more in isolated worktrees — all managed from one dashboard.",
    images: [{ url: "/og-image.png", width: 1024, height: 1024, alt: "Agent Orchestrator" }],
  },
  twitter: {
    card: "summary",
    site: "@aoagents",
    creator: "@aoagents",
    title: "Agent Orchestrator",
    description:
      "Open-source platform for running parallel AI coding agents. Spawn Claude Code, Codex, Aider, and more in isolated worktrees — all managed from one dashboard.",
    images: ["/og-image.png"],
  },
  alternates: {
    canonical: "https://aoagents.dev/",
  },
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
