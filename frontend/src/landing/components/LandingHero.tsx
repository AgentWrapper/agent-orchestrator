"use client";

import { useState } from "react";

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

const projects = [
	{
		name: "api-gateway",
		count: 4,
		tasks: ["Split terminal mux responsibilities", "fix auth timeout retry loop", "add rate limit headers"],
	},
	{
		name: "webgl-preview",
		count: 8,
		tasks: ["Restore fallback renderer affordance", "cache compiled shader programs", "ship frame statistics overlay"],
	},
	{
		name: "mobile-shell",
		count: 2,
		tasks: ["repair back swipe gesture", "profile sheet accessibility pass"],
	},
	{
		name: "billing-portal",
		count: 2,
		tasks: ["invoice CSV export", "tax id validation errors"],
	},
];

const columns = [
	{
		title: "Working",
		color: "#ffb454",
		cards: [
			{
				status: "Working",
				agent: "claude",
				title: "Split terminal mux responsibilities",
				branch: "session/ao-204",
				meta: "no PR yet",
			},
		],
	},
	{
		title: "Needs you",
		color: "#ff6b6b",
		cards: [
			{
				status: "CI failed",
				agent: "codex",
				title: "fix auth timeout retry loop",
				branch: "fix/auth-timeouts",
				meta: "PR #184 · open",
			},
		],
	},
	{
		title: "In review",
		color: "#8fb7ff",
		cards: [
			{
				status: "Review pending",
				agent: "opencode",
				title: "add rate limit headers",
				branch: "feat/rate-limit-headers",
				meta: "PR #185 · open",
			},
		],
	},
	{
		title: "Ready to merge",
		color: "#72e29b",
		cards: [
			{
				status: "Mergeable",
				agent: "cursor",
				title: "Build end-to-end onboarding test for published npm package",
				branch: "test/onboarding-harness",
				meta: "PR #204 · approved",
			},
			{
				status: "Checks passed",
				agent: "aider",
				title: "publish linux desktop install path",
				branch: "docs/linux-install",
				meta: "PR #211 · 2 approvals",
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
	const [activeProject, setActiveProject] = useState("api-gateway");
	const [activeCard, setActiveCard] = useState("fix auth timeout retry loop");
	const [activeProjectAction, setActiveProjectAction] = useState("api-gateway-board");
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({
		"api-gateway": true,
		"webgl-preview": true,
		"mobile-shell": true,
		"billing-portal": true,
	});

	function toggleProject(projectName: string) {
		setActiveProject(projectName);
		setOpenProjects((current) => ({
			...current,
			[projectName]: !current[projectName],
		}));
	}

	return (
		<div className="relative mx-auto mt-6 max-w-[1600px]" data-testid="hero-dashboard-interactive">
			<div className="pointer-events-none absolute -inset-x-8 -inset-y-10 rounded-[30px] bg-[color:var(--accent)] opacity-[0.04] blur-3xl" />
			<div className="relative overflow-hidden rounded-[18px] border border-[#17191f] bg-[#020203] shadow-[0_34px_120px_-76px_rgba(0,0,0,1)]">
				<div
					className="grid min-h-[640px] text-left text-[color:var(--fg)] transition-[grid-template-columns] duration-300"
					style={{ gridTemplateColumns: sidebarOpen ? "264px minmax(0, 1fr)" : "64px minmax(0, 1fr)" }}
				>
					<aside className="flex min-h-[640px] flex-col border-b border-[#15171d] bg-[#030304] md:border-b-0 md:border-r">
						<div className="flex h-14 items-center justify-between border-b border-[#17191f] px-5">
							<div
								className={`flex items-center gap-2 text-[15px] font-semibold ${sidebarOpen ? "" : "md:justify-center"}`}
							>
								<img src="/ao-logo.svg" alt="" className="h-5 w-5" draggable="false" />
								<span className={sidebarOpen ? "" : "md:hidden"}>Agent Orchestrator</span>
							</div>
							<button
								type="button"
								onClick={() => setSidebarOpen((current) => !current)}
								className="cursor-pointer rounded-md p-1.5 text-[#7a828f] transition-colors hover:bg-white/[0.06] hover:text-white"
								aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
								aria-expanded={sidebarOpen}
							>
								<SidebarIcon className="h-4 w-4" />
							</button>
						</div>
						{sidebarOpen ? (
							<div className="min-h-0 flex-1 overflow-hidden p-3">
								<div className="mb-3 flex items-center justify-between px-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#737b89]">
									Projects
									<span className="text-lg font-normal leading-none">+</span>
								</div>
								<div className="space-y-3">
									{projects.map((project) => (
										<div key={project.name} className="group">
											<button
												type="button"
												onClick={() => toggleProject(project.name)}
												className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left transition-colors ${
													activeProject === project.name
														? "bg-[#11131a] text-[#eceef2]"
														: "text-[#a0a6b2] hover:bg-[#0b0d12] hover:text-[#eceef2]"
												}`}
											>
												<ChevronIcon
													className={`h-3.5 w-3.5 shrink-0 transition-transform ${openProjects[project.name] ? "rotate-90" : ""}`}
												/>
												<span className="min-w-0 flex-1 truncate text-[15px] font-medium">{project.name}</span>
												<span className="hidden items-center gap-2 text-[#737b89] group-hover:flex">
													<span
														role="button"
														tabIndex={0}
														aria-label={`${project.name} board`}
														onClick={(event) => {
															event.stopPropagation();
															setActiveProject(project.name);
															setActiveProjectAction(`${project.name}-board`);
														}}
														onKeyDown={(event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																event.stopPropagation();
																setActiveProject(project.name);
																setActiveProjectAction(`${project.name}-board`);
															}
														}}
														className={`cursor-pointer rounded p-0.5 transition-colors hover:bg-white/10 hover:text-white ${
															activeProjectAction === `${project.name}-board` ? "text-white" : ""
														}`}
													>
														<GridIcon className="h-3.5 w-3.5" />
													</span>
													<span
														role="button"
														tabIndex={0}
														aria-label={`${project.name} orchestrator`}
														onClick={(event) => {
															event.stopPropagation();
															setActiveProject(project.name);
															setActiveProjectAction(`${project.name}-orchestrator`);
															setActiveCard(`Spawn ${project.name} orchestrator`);
														}}
														onKeyDown={(event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																event.stopPropagation();
																setActiveProject(project.name);
																setActiveProjectAction(`${project.name}-orchestrator`);
																setActiveCard(`Spawn ${project.name} orchestrator`);
															}
														}}
														className={`cursor-pointer rounded p-0.5 transition-colors hover:bg-white/10 hover:text-white ${
															activeProjectAction === `${project.name}-orchestrator` ? "text-white" : ""
														}`}
													>
														<NetworkIcon className="h-3.5 w-3.5" />
													</span>
													<span
														role="button"
														tabIndex={0}
														aria-label={`${project.name} options`}
														onClick={(event) => {
															event.stopPropagation();
															setActiveProject(project.name);
															setActiveProjectAction(`${project.name}-options`);
														}}
														onKeyDown={(event) => {
															if (event.key === "Enter" || event.key === " ") {
																event.preventDefault();
																event.stopPropagation();
																setActiveProject(project.name);
																setActiveProjectAction(`${project.name}-options`);
															}
														}}
														className={`cursor-pointer rounded p-0.5 transition-colors hover:bg-white/10 hover:text-white ${
															activeProjectAction === `${project.name}-options` ? "text-white" : ""
														}`}
													>
														<MoreIcon className="h-3.5 w-3.5" />
													</span>
												</span>
												<span className="min-w-5 rounded-md border border-[#181b22] bg-[#08090c] px-1.5 py-0.5 text-center text-[11px] leading-none text-[#7a828f] group-hover:hidden">
													{project.count}
												</span>
											</button>
											{openProjects[project.name] ? (
												<div className="mt-2 space-y-1.5 pl-8">
													{project.tasks.map((task, index) => (
														<button
															type="button"
															key={task}
															className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded py-1 text-left text-[13px] transition-colors ${
																activeCard === task ? "text-[#eceef2]" : "text-[#9aa1ac] hover:text-[#eceef2]"
															}`}
															onClick={() => {
																setActiveProject(project.name);
																setActiveCard(task);
															}}
														>
															<span
																className="h-1.5 w-1.5 shrink-0 rounded-full"
																style={{
																	backgroundColor: index === 1 ? "#ff7070" : index === 2 ? "#89919e" : "#ffad4d",
																}}
															/>
															<span className="truncate">{task}</span>
														</button>
													))}
												</div>
											) : null}
										</div>
									))}
								</div>
							</div>
						) : (
							<div className="hidden min-h-0 flex-1 flex-col items-center gap-3 p-3 md:flex">
								{projects.map((project) => (
									<button
										key={project.name}
										type="button"
										onClick={() => setActiveProject(project.name)}
										className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
											activeProject === project.name
												? "bg-[#11131a] text-[#eceef2]"
												: "text-[#8a92a0] hover:bg-[#0b0d12] hover:text-white"
										}`}
										aria-label={project.name}
										title={project.name}
									>
										{project.name.slice(0, 2)}
									</button>
								))}
							</div>
						)}
						<button
							className={`flex h-14 cursor-pointer items-center gap-3 border-t border-[#15171d] px-5 text-sm text-[#8a92a0] transition-colors hover:bg-[#090b10] hover:text-white ${sidebarOpen ? "" : "md:justify-center md:px-0"}`}
						>
							<SettingsIcon className="h-4 w-4" />
							<span className={sidebarOpen ? "" : "md:hidden"}>Settings</span>
						</button>
					</aside>

					<div className="min-w-0 bg-[#020203] p-5 sm:p-7">
						<div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
							<div className="flex items-end gap-3">
								<h2 className="text-[23px] font-bold leading-none">Board</h2>
								<p className="pb-0.5 text-[13px] text-[#6f7784]">
									Live agent sessions flowing from work → review → merge.
								</p>
							</div>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setActiveCard("New task drafted")}
									className="hero-pressable inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[#181b22] bg-[#050608] px-4 py-2 text-sm font-semibold text-[#9aa2af] hover:border-[#2b313d] hover:text-white"
								>
									<PlusIcon className="h-4 w-4" />
									New task
								</button>
								<button
									type="button"
									onClick={() => setActiveCard("Spawn Orchestrator")}
									className="hero-pressable inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold hover:brightness-110"
									style={{ color: "#081225" }}
								>
									<NetworkIcon className="h-4 w-4" />
									Spawn Orchestrator
								</button>
							</div>
						</div>

						<div className="grid gap-3 lg:grid-cols-4">
							{columns.map((column) => (
								<section key={column.title} className="min-h-[510px] rounded-xl bg-[#07080a] p-4">
									<div className="mb-5 flex items-center justify-between px-0.5">
										<div
											className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em]"
											style={{ color: column.color }}
										>
											<span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.color }} />
											{column.title}
										</div>
										<span className="text-xs text-[#68707d]">{column.cards.length}</span>
									</div>
									<div className="space-y-4">
										{column.cards.map((card) => (
											<button
												key={card.title}
												type="button"
												onClick={() => setActiveCard(card.title)}
												className={`hero-pressable w-full cursor-pointer rounded-lg border p-4 text-left ${
													activeCard === card.title
														? "border-[#2a3b5d] bg-[#0d111a]"
														: "border-[#181b22] bg-[#0d0f13] hover:border-[#2b313d] hover:bg-[#11141a]"
												}`}
											>
												<div className="mb-4 flex items-center justify-between">
													<span className="flex items-center gap-2 text-xs font-medium" style={{ color: column.color }}>
														<span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.color }} />
														{card.status}
													</span>
													<span className="font-mono text-[11px] text-[#6e7684]">{card.agent}</span>
												</div>
												<div className="text-[14px] font-semibold leading-[1.45] text-[#f0f1f4]">{card.title}</div>
												<div className="mt-4 font-mono text-[11px] text-[#68707d]">{card.branch}</div>
												<div className="mt-3 border-t border-[#252933] pt-3 font-mono text-[11px] text-[#68707d]">
													{card.meta}
												</div>
											</button>
										))}
									</div>
								</section>
							))}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

export function LandingHero() {
	return (
		<section
			data-testid="hero-section"
			id="top"
			className="relative overflow-hidden border-b border-[color:var(--border)] pb-10 pt-28 sm:pt-32 lg:pb-14"
		>
			<div
				className="pointer-events-none absolute inset-0 opacity-[0.24]"
				style={{
					backgroundImage:
						"linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
					backgroundSize: "44px 44px",
					maskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
					WebkitMaskImage: "radial-gradient(ellipse at 52% 42%, black 0%, transparent 68%)",
				}}
			/>
			<div className="relative z-10 mx-auto w-full max-w-[1680px] px-5 sm:px-8 lg:px-12 xl:px-16">
				<div className="mx-auto max-w-[1500px] text-center">
					<h1
						data-testid="hero-headline"
						className="mx-auto max-w-[1320px] font-display font-semibold leading-[0.98] text-[#f2f3f5]"
						style={{ fontSize: "clamp(38px, 4.35vw, 78px)", letterSpacing: "-0.035em" }}
					>
						<span className="block">Stop babysitting coding agents.</span>
						<span className="mt-2 block">
							Start merging <span className="text-[#93b4f8]">real work.</span>
						</span>
					</h1>
					<p className="mx-auto mt-7 max-w-[680px] text-[15px] font-medium leading-[1.75] text-[color:var(--fg-muted)] sm:text-[17px]">
						Free, Apache 2.0 licensed, and runs on your laptop. Fork it, inspect it, and ship your first parallel agent
						workflow in minutes.
					</p>
					<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
						<a
							href="/docs/installation"
							className="hero-pressable group inline-flex items-center gap-2 rounded-lg bg-[color:var(--accent)] px-7 py-3.5 text-[15px] font-bold hover:brightness-110"
							style={{ color: "#081225" }}
						>
							<DownloadIcon className="h-4 w-4" />
							Install Agent Orchestrator
							<ArrowRightIcon className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
						</a>
						<a
							href="https://github.com/AgentWrapper/agent-orchestrator"
							target="_blank"
							rel="noreferrer"
							className="hero-pressable inline-flex items-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-transparent px-5 py-3.5 text-[15px] font-semibold text-[color:var(--fg)] hover:bg-[color:var(--bg-card-hover)]"
						>
							<GithubIcon className="h-4 w-4" />
							<span>Star on GitHub</span>
							<span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[12px] leading-none text-[color:var(--fg-muted)]">
								7.7k
							</span>
						</a>
					</div>
				</div>

				<div className="mx-auto mt-12 flex max-w-[1600px] items-center gap-4 px-1 text-left">
					<div className="h-px flex-1 bg-gradient-to-r from-transparent via-[color:var(--border-strong)] to-[color:var(--border-strong)]" />
					<div className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--fg-dim)]">
						Live board preview
					</div>
					<div className="h-px flex-1 bg-gradient-to-r from-[color:var(--border-strong)] via-[color:var(--border-strong)] to-transparent" />
				</div>

				<HeroDashboardMockup />
			</div>
		</section>
	);
}
