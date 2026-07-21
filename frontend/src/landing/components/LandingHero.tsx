"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useGitHubRepoFacts } from "../lib/use-github-repo-facts";
import { useDownloadTarget, useIsMacDesktop } from "../lib/use-download-target";
import { CopyCommand } from "./CopyCommand";
import { ScaledMockup } from "./ScaledMockup";

if (typeof window !== "undefined") {
	gsap.registerPlugin(useGSAP);
}

const BREW_INSTALL_COMMAND = "brew install --cask agentwrapper/tap/agent-orchestrator";

function GithubIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.1.79-.25.79-.56v-2.15c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.3-.52-1.47.11-3.05 0 0 .97-.31 3.18 1.18A10.96 10.96 0 0 1 12 5.99c.98 0 1.97.13 2.9.38 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.16v3.2c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
		</svg>
	);
}

function ArrowRightIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</svg>
	);
}

function DownloadIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 3v12" />
			<path d="m7 10 5 5 5-5" />
			<path d="M5 21h14" />
		</svg>
	);
}

function StarIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M12 2.5l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.55l-5.91 3.11 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z" />
		</svg>
	);
}

const GITHUB_REPO_URL = "https://github.com/AgentWrapper/agent-orchestrator";

type BoardColumnId = "working" | "action" | "pending" | "merge";
type SessionZone = "working" | "warning" | "error" | "success" | "pending";

type BoardCard = {
	agent: string;
	branch: string;
	column: BoardColumnId;
	meta: string;
	status: string;
	title: string;
	zone: SessionZone;
};

type AppProject = {
	description: string;
	id: string;
	name: string;
	shortName: string;
	cards: BoardCard[];
};

const columnDefinitions: Record<BoardColumnId, { title: string; color: string; glow: string }> = {
	working: {
		title: "Working",
		color: "#f59f4c",
		glow: "rgba(245,159,76,0.07)",
	},
	action: {
		title: "Needs you",
		color: "#e8c14a",
		glow: "rgba(232,193,74,0.06)",
	},
	pending: {
		title: "In review",
		color: "#7f8794",
		glow: "rgba(255,255,255,0.02)",
	},
	merge: {
		title: "Ready to merge",
		color: "#74b98a",
		glow: "rgba(116,185,138,0.07)",
	},
};

const columnOrder: BoardColumnId[] = ["working", "action", "pending", "merge"];

const appProjects: AppProject[] = [
	{
		name: "atlas-api",
		id: "atlas-api",
		shortName: "API",
		description: "Edge API, auth, rate limits",
		cards: [
			{
				status: "Working",
				agent: "claude",
				title: "Split terminal mux responsibilities",
				branch: "session/ao-204",
				meta: "no PR yet",
				column: "working",
				zone: "working",
			},
			{
				status: "CI failed",
				agent: "codex",
				title: "fix auth timeout retry loop",
				branch: "fix/auth-timeouts",
				meta: "PR #184 · open",
				column: "action",
				zone: "error",
			},
			{
				status: "Review pending",
				agent: "opencode",
				title: "add rate limit headers",
				branch: "feat/rate-limit-headers",
				meta: "PR #185 · open",
				column: "pending",
				zone: "pending",
			},
			{
				status: "Ready",
				agent: "cursor",
				title: "Ship onboarding smoke test",
				branch: "test/onboarding-harness",
				meta: "PR #204 · approved",
				column: "merge",
				zone: "success",
			},
		],
	},
	{
		name: "canvas-preview",
		id: "canvas-preview",
		shortName: "GL",
		description: "In-app browser and preview runtime",
		cards: [
			{
				status: "Working",
				agent: "goose",
				title: "Restore fallback renderer affordance",
				branch: "fix/webgl-fallback",
				meta: "no PR yet",
				column: "working",
				zone: "working",
			},
			{
				status: "Blocked",
				agent: "codex",
				title: "cache compiled shader programs",
				branch: "perf/shader-cache",
				meta: "needs repro trace",
				column: "action",
				zone: "error",
			},
			{
				status: "Review pending",
				agent: "aider",
				title: "ship frame statistics overlay",
				branch: "feat/frame-stats",
				meta: "PR #219 · open",
				column: "pending",
				zone: "pending",
			},
			{
				status: "Approved",
				agent: "cursor",
				title: "stabilize browser preview sizing",
				branch: "fix/browser-bounds",
				meta: "PR #221 · approved",
				column: "merge",
				zone: "success",
			},
		],
	},
	{
		name: "mobile-client",
		id: "mobile-client",
		shortName: "IOS",
		description: "Mobile shell and handoff flows",
		cards: [
			{
				status: "Working",
				agent: "claude",
				title: "repair back swipe gesture",
				branch: "fix/back-swipe",
				meta: "no PR yet",
				column: "working",
				zone: "working",
			},
			{
				status: "Ready",
				agent: "opencode",
				title: "profile sheet accessibility pass",
				branch: "a11y/profile-sheet",
				meta: "PR #232 · approved",
				column: "merge",
				zone: "success",
			},
		],
	},
	{
		name: "revenue-portal",
		id: "revenue-portal",
		shortName: "REV",
		description: "Billing, invoices, tax flows",
		cards: [
			{
				status: "Review pending",
				agent: "aider",
				title: "invoice CSV export",
				branch: "feat/invoice-csv",
				meta: "PR #240 · open",
				column: "pending",
				zone: "pending",
			},
			{
				status: "Needs input",
				agent: "codex",
				title: "tax id validation errors",
				branch: "fix/tax-id-errors",
				meta: "review comment waiting",
				column: "action",
				zone: "error",
			},
			{
				status: "Approved",
				agent: "cursor",
				title: "receipt email copy refresh",
				branch: "copy/receipt-email",
				meta: "PR #244 · approved",
				column: "merge",
				zone: "success",
			},
		],
	},
];

function PlusIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 5v14" />
			<path d="M5 12h14" />
		</svg>
	);
}

function NetworkIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="M12 5v5" />
			<path d="M6 19v-4h12v4" />
			<path d="M4 19h4" />
			<path d="M10 10h4" />
			<path d="M16 19h4" />
		</svg>
	);
}

function ChevronIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

function GridIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			aria-hidden="true"
		>
			<path d="M4 4h6v6H4z" />
			<path d="M14 4h6v6h-6z" />
			<path d="M4 14h6v6H4z" />
			<path d="M14 14h6v6h-6z" />
		</svg>
	);
}

function MoreIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<circle cx="12" cy="5" r="1.6" />
			<circle cx="12" cy="12" r="1.6" />
			<circle cx="12" cy="19" r="1.6" />
		</svg>
	);
}

function SettingsIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			aria-hidden="true"
		>
			<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.88.34H9A1.7 1.7 0 0 0 10 3V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.88V9c.22.6.8 1 1.44 1H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
		</svg>
	);
}

function SidebarIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			aria-hidden="true"
		>
			<rect x="4" y="5" width="16" height="14" rx="2" />
			<path d="M9 5v14" />
		</svg>
	);
}

function HeroDashboardMockup() {
	const [projectsState, setProjectsState] = useState<AppProject[]>(appProjects);
	const [activeProject, setActiveProject] = useState<string>("all");
	const [activeCard, setActiveCard] = useState("fix auth timeout retry loop");
	const [activePanel, setActivePanel] = useState<"board" | "settings" | "terminal" | "newTask">("board");
	const [terminalTitle, setTerminalTitle] = useState("Session terminal");
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({
		"atlas-api": true,
		"canvas-preview": true,
		"mobile-client": true,
		"revenue-portal": true,
	});

	const selectedProject = projectsState.find((project) => project.id === activeProject);
	const visibleCards = selectedProject ? selectedProject.cards : projectsState.flatMap((project) => project.cards);
	const activeProjectLabel = selectedProject ? selectedProject.name : "All projects";
	const doneCount = selectedProject ? Math.max(1, Math.floor(selectedProject.cards.length / 2)) : 7;
	const boardColumns = columnOrder.map((columnId) => ({
		...columnDefinitions[columnId],
		id: columnId,
		cards: visibleCards.filter((card) => card.column === columnId),
	}));

	function showBoard(projectId: string) {
		setActiveProject(projectId);
		setActivePanel("board");
		const project = projectsState.find((entry) => entry.id === projectId);
		const firstCard = project?.cards[0];
		if (firstCard) setActiveCard(firstCard.title);
	}

	function showAllProjects() {
		setActiveProject("all");
		setActivePanel("board");
		setActiveCard("All project sessions");
	}

	function showTerminal(title: string) {
		setActivePanel("terminal");
		setTerminalTitle(title);
		setActiveCard(title);
	}

	function showNewTask() {
		if (!selectedProject) {
			showBoard(projectsState[0].id);
		}
		setActivePanel("newTask");
		setActiveCard("New task");
	}

	function toggleProject(projectName: string) {
		showBoard(projectName);
		setOpenProjects((current) => ({
			...current,
			[projectName]: !current[projectName],
		}));
	}

	return (
		<div className="hero-laptop relative mx-auto mt-6 w-full max-w-[1600px]" data-testid="hero-dashboard-interactive">
			<div className="hero-laptop-screen">
				<div className="hero-laptop-display">
					<div
						className="grid min-h-[640px] text-left text-[#f4f5f7] transition-[grid-template-columns] duration-200"
						style={{
							gridTemplateColumns: sidebarOpen ? "240px minmax(0, 1fr)" : "52px minmax(0, 1fr)",
							fontFamily:
								'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Helvetica Neue", sans-serif',
						}}
					>
						<aside className="flex min-h-[640px] overflow-hidden flex-col border-r border-[rgba(255,255,255,0.06)] bg-[#11100b]">
							<div
								className={`flex shrink-0 items-center gap-2.5 pt-3.5 ${
									sidebarOpen ? "px-5 pb-[18px]" : "justify-center px-1.5 pb-2"
								}`}
							>
								<button
									type="button"
									onClick={() => {
										if (sidebarOpen) {
											showAllProjects();
										} else {
											setSidebarOpen(true);
										}
									}}
									className={`grid shrink-0 place-items-center transition-colors ${
										sidebarOpen ? "h-[22px] w-[22px]" : "h-9 w-9 rounded-lg bg-white/[0.07]"
									}`}
									aria-label={sidebarOpen ? "Orchestrator board" : "Expand sidebar"}
								>
									<img
										src="/ao-logo.svg"
										alt=""
										className="h-[22px] w-[22px] rounded-[6px] object-cover"
										draggable="false"
									/>
								</button>
								<span
									className={`min-w-0 flex-1 truncate text-[14px] font-bold tracking-[-0.015em] ${sidebarOpen ? "" : "hidden"}`}
								>
									Agent Orchestrator
								</span>
								<button
									type="button"
									onClick={() => setSidebarOpen((current) => !current)}
									className={`grid size-[18px] shrink-0 place-items-center rounded-[4px] text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#f4f5f7] ${
										sidebarOpen ? "" : "hidden"
									}`}
									aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
								>
									<SidebarIcon className="h-[15px] w-[15px]" />
								</button>
							</div>
							{sidebarOpen ? (
								<div className="min-h-0 flex-1 overflow-hidden px-2.5 pr-[7px]">
									<div className="flex shrink-0 items-center justify-between px-2 pb-2">
										<div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[#646a73]">
											Projects
										</div>
										<button
											type="button"
											onClick={() => showTerminal("Create project")}
											className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#9ba1aa]"
											aria-label="Create project"
										>
											<PlusIcon className="h-[13px] w-[13px]" />
										</button>
									</div>
									<div className="space-y-px">
										{projectsState.map((project) => (
											<div key={project.id} className="relative">
												<button
													type="button"
													aria-expanded={openProjects[project.id]}
													onClick={() => toggleProject(project.id)}
													className={`relative flex h-9 w-full items-center gap-[9px] rounded-[5px] px-1.5 py-0 pr-[84px] text-left text-[13px] font-medium transition-colors before:absolute before:bottom-2 before:left-0 before:top-2 before:w-px before:rounded-full ${
														activeProject === project.id
															? "bg-white/[0.07] text-[#f4f5f7] before:bg-[#b0bdd8]"
															: "text-[#9ba1aa] before:bg-transparent hover:bg-white/[0.04] hover:text-[#f4f5f7]"
													}`}
												>
													<ChevronIcon
														className={`h-[9px] w-[9px] shrink-0 text-[#646a73] transition-transform ${
															openProjects[project.id] ? "rotate-90" : ""
														}`}
													/>
													<span className="min-w-0 flex-1 truncate">{project.name}</span>
													<span className="grid h-4 min-w-4 shrink-0 place-items-center rounded bg-white/[0.04] px-1 font-mono text-[10px] leading-none text-[#646a73]">
														{project.cards.length}
													</span>
												</button>
												<div className="absolute right-1 top-0 z-10 flex h-9 items-center gap-px">
													{[GridIcon, NetworkIcon, MoreIcon].map((Icon, index) => (
														<button
															key={`${project.id}-${index}`}
															type="button"
															onClick={(event) => {
																event.stopPropagation();
																if (index === 0) showBoard(project.id);
																if (index === 1) showTerminal(`Spawn ${project.name} orchestrator`);
																if (index === 2) {
																	setActiveProject(project.id);
																	setActivePanel("settings");
																	setActiveCard(`${project.name} settings`);
																}
															}}
															className="grid size-5 place-items-center rounded-md text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#f4f5f7] [&_svg]:size-[15px]"
															aria-label={`${project.name} action ${index + 1}`}
														>
															<Icon />
														</button>
													))}
												</div>
												{openProjects[project.id] ? (
													<div className="mx-0 ml-[18px] py-1 pl-2.5">
														{project.cards.slice(0, 3).map((session) => (
															<button
																type="button"
																key={session.title}
																onClick={() => {
																	showBoard(project.id);
																	setActiveCard(session.title);
																}}
																className={`relative flex h-auto w-full items-center gap-[9px] rounded-[4px] py-[5px] pl-2.5 pr-1.5 text-left transition-colors before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-px before:rounded-full ${
																	activeCard === session.title
																		? "text-[#f4f5f7] before:bg-[#b0bdd8]"
																		: "text-[#9ba1aa] before:bg-transparent hover:text-[#f4f5f7]"
																}`}
															>
																<SessionDot zone={session.zone} />
																<span className="min-w-0 flex-1 truncate text-[12px]">{session.title}</span>
															</button>
														))}
													</div>
												) : null}
											</div>
										))}
									</div>
								</div>
							) : (
								<div className="hidden min-h-0 flex-1 flex-col items-center gap-1 px-1.5 md:flex">
									{projectsState.map((project) => (
										<button
											key={project.id}
											type="button"
											onClick={() => showBoard(project.id)}
											className={`grid h-9 w-9 place-items-center rounded-lg text-[13px] font-semibold uppercase transition-colors ${
												activeProject === project.id
													? "bg-white/[0.07] text-[#f4f5f7]"
													: "text-[#646a73] hover:bg-white/[0.04] hover:text-[#f4f5f7]"
											}`}
											aria-label={project.name}
											title={project.name}
										>
											{project.name.charAt(0)}
										</button>
									))}
								</div>
							)}
							<div
								className={`mt-auto border-t border-[rgba(255,255,255,0.06)] p-[7px] ${sidebarOpen ? "" : "flex justify-center"}`}
							>
								<button
									type="button"
									onClick={() => {
										setActivePanel("settings");
										setActiveCard("Settings");
									}}
									className={`flex h-[37px] w-full items-center gap-2.5 rounded-md p-2 text-[13px] font-medium text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#f4f5f7] ${sidebarOpen ? "" : "justify-center"}`}
								>
									<SettingsIcon className="h-[15px] w-[15px]" />
									<span className={sidebarOpen ? "" : "hidden"}>Settings</span>
								</button>
							</div>
						</aside>

						<div className="relative flex min-w-0 flex-col bg-[#14120d]">
							<div className="flex items-center gap-3 px-[18px] pt-[22px]">
								<div className="flex min-w-0 items-baseline gap-3">
									<h2 className="text-[21px] font-bold tracking-[-0.025em] text-[#f4f5f7]">Board</h2>
									<span className="text-[12.5px] text-[#646a73]">
										{activeProjectLabel} · sessions flowing from work → review → merge.
									</span>
								</div>
								<div className="ml-auto flex shrink-0 items-center gap-2">
									<button
										type="button"
										onClick={showNewTask}
										className="hero-pressable inline-flex h-[34px] items-center gap-1.5 rounded-[7px] border border-[rgba(255,255,255,0.07)] bg-[#211d14] px-[15px] text-[13px] font-semibold leading-none text-[#9ba1aa] hover:bg-[#252116] hover:text-[#f4f5f7]"
									>
										<PlusIcon className="h-3.5 w-3.5" />
										New task
									</button>
									<button
										type="button"
										onClick={() => showTerminal(`Orchestrator · ${activeProjectLabel}`)}
										className="hero-pressable inline-flex h-[34px] items-center gap-1.5 rounded-[7px] bg-[color:var(--accent)] px-[15px] text-[13px] font-semibold leading-none text-[#11140c] hover:brightness-110"
									>
										<NetworkIcon className="h-3.5 w-3.5" />
										Orchestrator
									</button>
								</div>
							</div>

							<div className="min-h-0 flex-1 overflow-hidden p-[18px]">
								{activePanel === "settings" ? (
									<MockSettingsPanel activeProjectLabel={activeProjectLabel} />
								) : activePanel === "terminal" ? (
									<MockTerminalPanel activeProjectLabel={activeProjectLabel} title={terminalTitle} />
								) : (
									<div className="grid h-full grid-cols-4 gap-2">
										{boardColumns.map((column) => (
											<section
												key={column.id}
												className="flex min-w-0 flex-col overflow-hidden rounded-[13px]"
												style={{
													background: `linear-gradient(180deg, ${column.glow}, transparent 130px), rgba(255,255,255,0.028)`,
												}}
											>
												<div className="flex shrink-0 items-center gap-[9px] px-[15px] pb-[11px] pt-[14px]">
													<span
														className={`h-[7px] w-[7px] rounded-full ${column.id === "pending" ? "" : "pulse-dot"}`}
														style={{
															background: column.color,
															boxShadow:
																column.id === "pending"
																	? undefined
																	: `0 0 7px color-mix(in srgb, ${column.color} 60%, transparent)`,
														}}
													/>
													<div
														className="text-[11px] font-semibold uppercase tracking-[0.08em]"
														style={{ color: column.color }}
													>
														{column.title}
													</div>
													<span className="ml-auto font-mono text-[11px] leading-none text-[#646a73]">
														{column.cards.length}
													</span>
												</div>
												<div className="min-h-0 flex-1 overflow-hidden px-[11px] pb-3">
													<div className="flex flex-col gap-2.5">
														{column.cards.map((card) => (
															<button
																key={`${card.branch}-${card.title}`}
																type="button"
																onClick={() => showTerminal(card.title)}
																className="w-full rounded-[7px] border border-[rgba(255,255,255,0.06)] bg-[#1a1812] text-left transition-colors hover:border-[rgba(255,255,255,0.10)]"
															>
																<div className="flex items-center gap-2 px-[13px] pb-[9px] pt-3">
																	<span
																		className="inline-flex items-center gap-1.5 text-[11px] font-medium"
																		style={{
																			color:
																				card.status === "CI failed" ||
																				card.status === "Blocked" ||
																				card.status === "Needs input"
																					? "#ef6b6b"
																					: column.color,
																		}}
																	>
																		<span className="pulse-dot h-[7px] w-[7px] rounded-full bg-current" />
																		{card.status}
																	</span>
																	<span className="ml-auto shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-[#646a73]">
																		{card.agent}
																	</span>
																</div>
																<div className="line-clamp-2 overflow-hidden px-[13px] pb-2 text-[13px] font-medium leading-[1.42] tracking-[-0.01em] text-[#f4f5f7]">
																	{card.title}
																</div>
																<div className="px-[13px] pb-2.5 font-mono text-[10.5px] text-[#646a73]">
																	{card.branch}
																</div>
																<div className="border-t border-[rgba(255,255,255,0.06)] px-[13px] py-2 font-mono text-[10.5px] text-[#646a73]">
																	{card.meta}
																</div>
															</button>
														))}
													</div>
												</div>
											</section>
										))}
									</div>
								)}
							</div>
							{activePanel === "newTask" ? (
								<MockNewTaskDialog
									activeProjectLabel={selectedProject?.name ?? projectsState[0].name}
									onClose={() => setActivePanel("board")}
									onStart={(newTask) => {
										setProjectsState((current) =>
											current.map((p) => {
												if (p.id === (selectedProject?.id ?? current[0].id)) {
													return { ...p, cards: [newTask, ...p.cards] };
												}
												return p;
											}),
										);
										showTerminal(newTask.title);
									}}
								/>
							) : null}
							<div className="shrink-0 border-t border-[rgba(255,255,255,0.06)] px-[18px]">
								<div className="flex min-h-[51px] items-center gap-2 py-2 text-[#9ba1aa]">
									<ChevronIcon className="h-3 w-3 text-[#646a73]" />
									<span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em]">
										Done / Terminated
									</span>
									<span className="ml-auto shrink-0 font-mono text-[10px] text-[#646a73]">{doneCount}</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function MockTerminalPanel({ activeProjectLabel, title }: { activeProjectLabel: string; title: string }) {
	return (
		<div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_270px] overflow-hidden rounded-[13px] border border-[rgba(255,255,255,0.07)] bg-[#0c0d0f]">
			<div className="flex min-w-0 flex-col bg-[#15171b]">
				<div className="flex h-[47px] shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.07)] px-4">
					<div className="flex min-w-0 items-baseline gap-2">
						<span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#646a73]">
							Terminal
						</span>
						<span className="truncate text-[12px] font-semibold text-[#9ba1aa]">{activeProjectLabel}</span>
					</div>
					<div className="flex items-center gap-3 font-mono text-[10.5px] text-[#9ba1aa]">
						<button type="button" className="text-[#646a73]">
							-
						</button>
						<span>13px</span>
						<button type="button" className="text-[#646a73]">
							+
						</button>
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden bg-[#15171b] p-4 font-mono text-[12px] leading-6 text-[#d5d7dc]">
					<div className="text-[#f0c84b]">⚠ `--dangerously-bypass-hook-trust` is enabled.</div>
					<div className="mt-4 rounded-[6px] border border-[rgba(255,255,255,0.22)] bg-[#17191d] p-4">
						<div className="text-[13px] font-bold text-[#f4f5f7]">OpenAI Codex</div>
						<div className="mt-4 grid grid-cols-[86px_1fr] gap-y-2">
							<span className="text-[#858b95]">model:</span>
							<span>
								gpt-5.5 <span className="text-[#6ec8e8]">/model</span>
							</span>
							<span className="text-[#858b95]">directory:</span>
							<span>~/.ao/data/worktrees/{activeProjectLabel.toLowerCase().replaceAll(" ", "-")}</span>
							<span className="text-[#858b95]">permissions:</span>
							<span className="font-semibold text-[#a98cff]">YOLO mode</span>
						</div>
					</div>
					<div className="mt-5 text-[#f4f5f7]">› ao session open "{title}"</div>
					<div className="mt-2 text-[#9ba1aa]">• What would you like me to do?</div>
					<div className="mt-6">
						<span className="text-[#f4f5f7]">› </span>
						<span className="rounded-sm bg-[#f59f4c] px-[3px] text-[#11100b]"> </span>
						<span className="text-[#858b95]"> Use /skills to list available skills</span>
					</div>
					<div className="mt-5 text-[#ffd28a]">
						gpt-5.5 default ·{" "}
						<span className="text-[#9bd39a]">
							~/.ao/data/worktrees/{activeProjectLabel.toLowerCase().replaceAll(" ", "-")}
						</span>
					</div>
				</div>
			</div>
			<aside className="flex min-w-0 flex-col border-l border-[rgba(255,255,255,0.07)] bg-[#0d0f12]">
				<div className="flex h-[47px] shrink-0 items-center gap-1 border-b border-[rgba(255,255,255,0.07)] px-2">
					{["Summary", "Reviews", "Browser"].map((tab, index) => (
						<div
							key={tab}
							className={`flex h-8 flex-1 items-center justify-center rounded-[7px] text-[11px] font-semibold ${
								index === 0 ? "bg-white/[0.07] text-[#f4f5f7]" : "text-[#646a73]"
							}`}
						>
							{tab}
						</div>
					))}
				</div>
				<div className="min-h-0 flex-1 overflow-hidden p-4">
					<div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#646a73]">Pull request</div>
					<div className="mt-3 text-[12px] text-[#9ba1aa]">No pull request opened yet.</div>
					<div className="mt-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[#646a73]">Activity</div>
					<div className="mt-4 space-y-4 text-[12px]">
						<div className="flex gap-2">
							<span className="mt-1.5 h-2 w-2 rounded-full bg-[#f59f4c]" />
							<div>
								<div className="text-[#f4f5f7]">Session active</div>
								<div className="mt-1 font-mono text-[10px] text-[#646a73]">just now</div>
							</div>
						</div>
						<div className="flex gap-2">
							<span className="mt-1.5 h-2 w-2 rounded-full bg-[#646a73]" />
							<div>
								<div className="text-[#d5d7dc]">Created worktree & branch</div>
								<div className="mt-1 font-mono text-[10px] text-[#646a73]">1d ago</div>
							</div>
						</div>
					</div>
					<div className="mt-7 font-mono text-[10px] uppercase tracking-[0.12em] text-[#646a73]">Overview</div>
					<div className="mt-4 grid grid-cols-[70px_1fr] gap-y-3 text-[11.5px]">
						<span className="text-[#858b95]">Agent</span>
						<span className="font-mono text-[#f4f5f7]">codex</span>
						<span className="text-[#858b95]">Branch</span>
						<span className="truncate font-mono text-[#f4f5f7]">ao/{activeProjectLabel}/root</span>
						<span className="text-[#858b95]">Session</span>
						<span className="font-mono text-[#f4f5f7]">{title.slice(0, 16).toLowerCase()}</span>
					</div>
				</div>
			</aside>
		</div>
	);
}

function MockSettingsPanel({ activeProjectLabel }: { activeProjectLabel: string }) {
	return (
		<div className="h-full min-h-0 overflow-hidden rounded-[13px] bg-[#14120d] text-[#f4f5f7]">
			<div className="border-b border-[rgba(255,255,255,0.07)] px-5 py-4">
				<h3 className="text-[18px] font-bold tracking-[-0.02em]">Settings</h3>
				<div className="mt-1 font-mono text-[11px] text-[#646a73]">/repos/{activeProjectLabel}</div>
			</div>
			<div className="mx-auto flex max-w-[620px] flex-col gap-3 overflow-hidden p-4">
				<SettingsCard title="Identity">
					<ReadonlySetting label="id" value={activeProjectLabel.toLowerCase().replaceAll(" ", "-")} />
					<ReadonlySetting label="path" value={`~/code/${activeProjectLabel.toLowerCase().replaceAll(" ", "-")}`} />
					<ReadonlySetting label="repo" value={`github.com/acme/${activeProjectLabel}`} />
				</SettingsCard>
				<SettingsCard title="Worktrees">
					<MockField label="Default branch" value="main" />
					<MockField label="Session prefix" value="ao" />
				</SettingsCard>
				<SettingsCard title="Agents">
					<MockSelect label="Default worker agent" value="codex" />
					<MockSelect label="Default orchestrator agent" value="claude-code" />
					<MockField label="Model override" value="(agent default)" muted />
					<MockSelect label="Permission mode" value="Bypass permissions" />
				</SettingsCard>
				<div className="flex items-center gap-3 pt-1">
					<button
						className="h-8 rounded-md bg-[color:var(--accent)] px-3 text-[12px] font-semibold text-[#11140c]"
						type="button"
					>
						Save changes
					</button>
					<span className="text-[12px] text-[#74b98a]">Saved.</span>
				</div>
			</div>
		</div>
	);
}

function MockNewTaskDialog({
	activeProjectLabel,
	onClose,
	onStart,
}: {
	activeProjectLabel: string;
	onClose: () => void;
	onStart: (task: BoardCard) => void;
}) {
	const [title, setTitle] = useState("");
	const [brief, setBrief] = useState("");
	const [agent, setAgent] = useState("claude-code");
	const [branch, setBranch] = useState("");

	const handleStart = () => {
		if (!title.trim()) return;
		onStart({
			agent,
			branch: branch || "feat/new-task",
			column: "working",
			meta: "Started just now",
			status: "Working",
			title,
			zone: "working",
		});
	};

	return (
		<div className="absolute inset-0 z-20 grid place-items-center bg-black/55 px-6">
			<div className="w-[min(560px,calc(100%-32px))] rounded-lg border border-[rgba(255,255,255,0.09)] bg-[#111318] text-[#f4f5f7] shadow-2xl">
				<div className="flex items-start justify-between gap-4 border-b border-[rgba(255,255,255,0.08)] px-5 py-4">
					<div className="min-w-0">
						<h3 className="text-[15px] font-semibold">New task</h3>
						<p className="mt-1 text-[12px] text-[#858b95]">Start a worker directly from {activeProjectLabel}.</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="grid size-7 shrink-0 place-items-center rounded-md text-[#858b95] transition hover:bg-white/[0.06] hover:text-[#f4f5f7]"
						aria-label="Close new task dialog"
					>
						×
					</button>
				</div>
				<div className="space-y-4 px-5 py-4">
					<DialogInput label="Title" value={title} onChange={setTitle} placeholder="e.g. Fix WebGL fallback renderer" />
					<label className="block space-y-1.5">
						<span className="text-[12px] font-medium text-[#9ba1aa]">Brief</span>
						<textarea
							value={brief}
							onChange={(e) => setBrief(e.target.value)}
							placeholder="Describe what the agent should do..."
							className="min-h-[112px] w-full resize-none rounded-md border border-[rgba(255,255,255,0.10)] bg-transparent px-3 py-2 text-[13px] leading-relaxed text-[#d5d7dc] outline-none focus:border-[color:var(--accent)]"
						/>
					</label>
					<div className="grid gap-3 sm:grid-cols-2">
						<DialogSelect
							label="Agent"
							value={agent}
							onChange={setAgent}
							options={["claude-code", "codex", "aider", "cursor", "opencode", "goose"]}
						/>
						<DialogInput label="Branch" value={branch} onChange={setBranch} placeholder="e.g. fix/webgl-fallback" />
					</div>
					<div className="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							onClick={onClose}
							className="h-8 rounded-md px-3 text-[12px] font-semibold text-[#9ba1aa] transition hover:bg-white/[0.06] hover:text-[#f4f5f7]"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleStart}
							disabled={!title.trim()}
							className="h-8 rounded-md bg-[color:var(--accent)] px-3 text-[12px] font-semibold text-[#11140c] transition hover:brightness-110 disabled:opacity-50"
						>
							Start task
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function SettingsCard({ children, title }: { children: ReactNode; title: string }) {
	return (
		<section className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-white/[0.025]">
			<div className="border-b border-[rgba(255,255,255,0.07)] px-4 py-3">
				<div className="text-[13px] font-semibold">{title}</div>
			</div>
			<div className="flex flex-col gap-3 p-4">{children}</div>
		</section>
	);
}

function ReadonlySetting({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[90px_1fr] gap-3 font-mono text-[11px]">
			<span className="text-[#858b95]">{label}</span>
			<span className="truncate text-[#d5d7dc]">{value}</span>
		</div>
	);
}

function MockField({ label, muted = false, value }: { label: string; muted?: boolean; value: string }) {
	return (
		<div className="grid grid-cols-[150px_1fr] items-center gap-3">
			<span className="text-[12px] text-[#9ba1aa]">{label}</span>
			<div
				className={`flex h-8 items-center rounded-md border border-[rgba(255,255,255,0.10)] bg-transparent px-2.5 text-[13px] ${
					muted ? "text-[#646a73]" : "text-[#f4f5f7]"
				}`}
			>
				{value}
			</div>
		</div>
	);
}

function MockSelect({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[150px_1fr] items-center gap-3">
			<span className="text-[12px] text-[#9ba1aa]">{label}</span>
			<div className="flex h-8 items-center justify-between rounded-md border border-[rgba(255,255,255,0.10)] bg-[#17191d] px-2.5 text-[13px] text-[#f4f5f7]">
				<span>{value}</span>
				<span className="text-[#646a73]">⌄</span>
			</div>
		</div>
	);
}

function DialogInput({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	return (
		<label className="block space-y-1.5">
			<span className="text-[12px] font-medium text-[#9ba1aa]">{label}</span>
			<input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="flex h-8 w-full items-center justify-between rounded-md border border-[rgba(255,255,255,0.10)] bg-transparent px-3 text-[13px] text-[#f4f5f7] outline-none focus:border-[color:var(--accent)]"
			/>
		</label>
	);
}

function DialogSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	options: string[];
}) {
	return (
		<label className="block space-y-1.5">
			<span className="text-[12px] font-medium text-[#9ba1aa]">{label}</span>
			<span className="relative block">
				<select
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className="flex h-8 w-full appearance-none items-center justify-between rounded-md border border-[rgba(255,255,255,0.10)] bg-transparent pl-3 pr-8 text-[13px] text-[#f4f5f7] outline-none focus:border-[color:var(--accent)]"
				>
					{options.map((opt) => (
						<option key={opt} value={opt} className="bg-[#111318]">
							{opt}
						</option>
					))}
				</select>
				<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#646a73]">⌄</span>
			</span>
		</label>
	);
}

function SessionDot({ zone }: { zone: string }) {
	const color =
		zone === "working"
			? "#f59f4c"
			: zone === "warning"
				? "#e8c14a"
				: zone === "error"
					? "#ef6b6b"
					: zone === "success"
						? "#74b98a"
						: "#646a73";
	return <span className="mt-px h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

export function LandingHero() {
	const containerRef = useRef<HTMLDivElement>(null);
	const { stars, latestRelease } = useGitHubRepoFacts();
	const downloadTarget = useDownloadTarget();
	const showBrew = useIsMacDesktop();

	useGSAP(
		() => {
			// Autonomous intro motion is skipped for reduced-motion users; the
			// content is fully visible without it.
			if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

			const ctx = gsap.context(() => {
				const tl = gsap.timeline({ defaults: { ease: "power4.out" } });

				// Initial state
				gsap.set(".gsap-reveal", { y: 40, opacity: 0 });
				gsap.set(".gsap-scale", { scale: 0.95, opacity: 0 });

				tl.to(".gsap-reveal", {
					y: 0,
					opacity: 1,
					duration: 1.2,
					stagger: 0.15,
				}).to(
					".gsap-scale",
					{
						scale: 1,
						opacity: 1,
						duration: 1.2,
						ease: "elastic.out(1, 0.75)",
					},
					"-=0.8",
				);
			}, containerRef);

			return () => ctx.revert();
		},
		{ scope: containerRef },
	);

	return (
		<section
			ref={containerRef}
			data-testid="hero-section"
			id="top"
			className="landing-hero-section relative overflow-hidden border-b border-[color:var(--border)] pt-24"
		>
			<div
				className="pointer-events-none absolute inset-0 opacity-[0.12]"
				style={{
					backgroundImage:
						"linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
					backgroundSize: "56px 56px",
					maskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
					WebkitMaskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
				}}
			/>
			<div className="relative z-10 mx-auto w-full max-w-[1200px] px-5 sm:px-8 lg:px-12 xl:px-16">
				<div className="mx-auto text-center">
					<div className="gsap-reveal mb-7 flex items-center justify-center">
						<a
							href="https://github.com/AgentWrapper/agent-orchestrator/releases"
							target="_blank"
							rel="noreferrer"
							className="hero-release-pill group inline-flex items-center gap-2.5 rounded-full border border-[color:var(--border)] bg-[color:var(--bg-card)] py-1.5 pl-2 pr-3.5 text-left transition-colors hover:border-[color:var(--accent-glow)]"
						>
							<span className="rounded-full bg-[color:var(--accent-soft)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--accent)]">
								New
							</span>
							<span className="text-[12.5px] font-medium text-[color:var(--fg-muted)] transition-colors group-hover:text-[color:var(--fg)]">
								{latestRelease ? `${latestRelease} · nightly builds daily` : "Nightly builds ship daily"}
							</span>
							<ArrowRightIcon className="h-3 w-3 text-[color:var(--fg-dim)] transition-transform duration-200 group-hover:translate-x-0.5" />
						</a>
					</div>
					<h1 data-testid="hero-headline" className="gsap-reveal landing-hero-heading mx-auto">
						<span className="landing-hero-heading-setup block">Stop babysitting agents.</span>
						<span className="landing-hero-heading-action block">
							Start merging <span className="landing-hero-heading-accent">real work.</span>
						</span>
					</h1>
					<p
						data-testid="hero-subhead"
						className="gsap-reveal mx-auto mt-6 max-w-[640px] text-balance text-[16px] leading-[1.65] text-[color:var(--fg-muted)] sm:text-[17.5px]"
					>
						Mission control for a fleet of coding agents — <span className="text-[color:var(--fg)]">23 harnesses</span>{" "}
						in isolated worktrees, with CI and review feedback routed back to the agent that owns the branch.
					</p>
					<div className="gsap-reveal mt-8 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
						{downloadTarget ? (
							<a
								href={downloadTarget.href}
								className="hero-pressable btn-primary group inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] px-6 text-[15px] font-semibold sm:w-auto"
							>
								<DownloadIcon className="h-4 w-4" />
								{downloadTarget.label}
							</a>
						) : (
							<a
								href={GITHUB_REPO_URL}
								target="_blank"
								rel="noreferrer"
								className="hero-pressable btn-primary group inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] px-6 text-[15px] font-semibold sm:w-auto"
							>
								<GithubIcon className="h-4 w-4" />
								Get Agent Orchestrator
							</a>
						)}
						<a
							href={GITHUB_REPO_URL}
							target="_blank"
							rel="noreferrer"
							className="hero-pressable gh-star-btn group relative inline-flex h-12 w-full items-center justify-center gap-2 overflow-visible rounded-[6px] border border-[color:var(--border-strong)] bg-transparent px-6 text-[15px] font-semibold text-[color:var(--fg)] hover:border-[color:var(--accent-glow)] hover:bg-[color:var(--bg-card-hover)] sm:w-auto"
						>
							<GithubIcon className="h-4 w-4" />
							<span>Star on GitHub</span>
							<span className="relative inline-flex items-center">
								<StarIcon className="gh-star h-4 w-4 text-[color:var(--fg-muted)]" />
								<span
									className="gh-sparkle absolute -right-1 -top-1 h-1 w-1 rounded-full bg-[#ffd35c]"
									style={{ ["--sx" as string]: "7px", ["--sy" as string]: "-7px" }}
								/>
								<span
									className="gh-sparkle gh-sparkle-2 absolute -bottom-1 left-0 h-1 w-1 rounded-full bg-[color:var(--accent)]"
									style={{ ["--sx" as string]: "-6px", ["--sy" as string]: "6px" }}
								/>
							</span>
							<span
								className={`gh-star-count rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[12px] leading-none text-[color:var(--fg-muted)] ${stars ? "" : "hidden"}`}
							>
								{stars}
							</span>
						</a>
					</div>

					<div className="gsap-reveal mt-5 flex flex-col items-center justify-center gap-3">
						{showBrew ? (
							<CopyCommand
								command={BREW_INSTALL_COMMAND}
								label="brew install command"
								nowrap
								className="w-full sm:w-auto"
							/>
						) : null}
					</div>
				</div>

				<div className="gsap-reveal mx-auto mt-14 flex max-w-[1200px] items-center gap-4 px-1 text-left sm:mt-16">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-[color:var(--border-strong)] to-[color:var(--border-strong)]" />
					<div className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">
						Live preview — click around
					</div>
					<div className="h-px flex-1 bg-gradient-to-r from-[color:var(--border-strong)] via-[color:var(--border-strong)] to-transparent" />
				</div>

				<div className="gsap-scale mt-10">
					<ScaledMockup designWidth={1080}>
						<HeroDashboardMockup />
					</ScaledMockup>
				</div>
			</div>
		</section>
	);
}
