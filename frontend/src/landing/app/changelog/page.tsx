import type { Metadata } from "next";
import { ChangelogPage } from "./ChangelogPage";

export const metadata: Metadata = {
	title: "Changelog — Agent Orchestrator",
	description: "Every merged Agent Orchestrator pull request, organized into real product updates.",
	alternates: {
		canonical: "https://aoagents.dev/changelog",
	},
};

export default function ChangelogIndexPage() {
	return <ChangelogPage currentPage={1} />;
}
