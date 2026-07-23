import type { Metadata } from "next";

const description =
	"Mission control for a fleet of coding agents. Run Claude Code, Codex, Cursor and 20 more harnesses in isolated git worktrees - AO watches every PR and routes CI and review feedback back to the agent that owns the branch.";

export const metadata: Metadata = {
	title: "Agent Orchestrator - Mission control for coding agents",
	description,
	openGraph: {
		type: "website",
		url: "https://aoagents.dev/landing",
		siteName: "Agent Orchestrator",
		title: "Agent Orchestrator - Mission control for coding agents",
		description,
		images: [{ url: "/og-image.png", width: 1024, height: 1024, alt: "Agent Orchestrator" }],
	},
	twitter: {
		card: "summary",
		site: "@aoagents",
		creator: "@aoagents",
		title: "Agent Orchestrator - Mission control for coding agents",
		description,
		images: ["/og-image.png"],
	},
	alternates: {
		canonical: "https://aoagents.dev/",
	},
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
	return <>{children}</>;
}
