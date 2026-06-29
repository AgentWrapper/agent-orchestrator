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

const appProjects = [
	{
		name: "api-gateway",
		id: "api-gateway",
		count: 4,
		sessions: [
			{ title: "Split terminal mux responsibilities", zone: "working" },
			{ title: "fix auth timeout retry loop", zone: "error" },
			{ title: "add rate limit headers", zone: "pending" },
		],
	},
	{
		name: "webgl-preview",
		id: "webgl-preview",
		count: 8,
		sessions: [
			{ title: "Restore fallback renderer affordance", zone: "warning" },
			{ title: "cache compiled shader programs", zone: "error" },
			{ title: "ship frame statistics overlay", zone: "pending" },
		],
	},
	{
		name: "mobile-shell",
		id: "mobile-shell",
		count: 2,
		sessions: [
			{ title: "repair back swipe gesture", zone: "working" },
			{ title: "profile sheet accessibility pass", zone: "success" },
		],
	},
	{
		name: "billing-portal",
		id: "billing-portal",
		count: 2,
		sessions: [
			{ title: "invoice CSV export", zone: "pending" },
			{ title: "tax id validation errors", zone: "error" },
		],
	},
];

const appColumns = [
	{
		title: "Working",
		level: "working",
		color: "#f59f4c",
		glow: "rgba(245,159,76,0.07)",
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
		level: "action",
		color: "#e8c14a",
		glow: "rgba(232,193,74,0.06)",
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
		level: "pending",
		color: "#646a73",
		glow: "rgba(255,255,255,0.02)",
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
		level: "merge",
		color: "#74b98a",
		glow: "rgba(116,185,138,0.07)",
		cards: [
			{
				status: "Ready",
				agent: "cursor",
				title: "Build end-to-end onboarding test for published npm package",
				branch: "test/onboarding-harness",
				meta: "PR #204 · approved",
			},
			{
				status: "Approved",
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
			<div className="relative overflow-hidden rounded-[18px] border border-[rgba(255,255,255,0.08)] bg-[#0a0b0d] shadow-[0_34px_120px_-76px_rgba(0,0,0,1)]">
				<div
					className="grid min-h-[640px] text-left text-[#f4f5f7] transition-[grid-template-columns] duration-200"
					style={{
						gridTemplateColumns: sidebarOpen ? "240px minmax(0, 1fr)" : "52px minmax(0, 1fr)",
						fontFamily:
							'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Helvetica Neue", sans-serif',
					}}
				>
					<aside className="flex min-h-[640px] overflow-hidden flex-col border-r border-[rgba(255,255,255,0.06)] bg-[#08090b]">
						<div
							className={`flex shrink-0 items-center gap-2.5 pt-3.5 ${
								sidebarOpen ? "px-5 pb-[18px]" : "justify-center px-1.5 pb-2"
							}`}
						>
							<button
								type="button"
								onClick={() => {
									if (sidebarOpen) {
										setActiveProject("api-gateway");
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
									<div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[#646a73]">Projects</div>
									<button className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#9ba1aa]">
										<PlusIcon className="h-[13px] w-[13px]" />
									</button>
								</div>
								<div className="space-y-px">
									{appProjects.map((project) => (
										<div key={project.id} className="relative">
											<button
												type="button"
												aria-expanded={openProjects[project.id]}
												onClick={() => toggleProject(project.id)}
												className={`relative flex h-9 w-full items-center gap-[9px] rounded-[5px] px-1.5 py-0 pr-[84px] text-left text-[13px] font-medium transition-colors before:absolute before:bottom-2 before:left-0 before:top-2 before:w-px before:rounded-full ${
													activeProject === project.id
														? "bg-white/[0.07] text-[#f4f5f7] before:bg-[#4d8dff]"
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
													{project.count}
												</span>
											</button>
											<div className="absolute right-1 top-0 z-10 flex h-9 items-center gap-px">
												{[GridIcon, NetworkIcon, MoreIcon].map((Icon, index) => (
													<button
														key={`${project.id}-${index}`}
														type="button"
														onClick={(event) => {
															event.stopPropagation();
															setActiveProject(project.id);
															if (index === 1) setActiveCard(`Spawn ${project.name} orchestrator`);
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
													{project.sessions.map((session) => (
														<button
															type="button"
															key={session.title}
															onClick={() => {
																setActiveProject(project.id);
																setActiveCard(session.title);
															}}
															className={`relative flex h-auto w-full items-center gap-[9px] rounded-[4px] py-[5px] pl-2.5 pr-1.5 text-left transition-colors before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-px before:rounded-full ${
																activeCard === session.title
																	? "text-[#f4f5f7] before:bg-[#4d8dff]"
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
								{appProjects.map((project) => (
									<button
										key={project.id}
										type="button"
										onClick={() => setActiveProject(project.id)}
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
								className={`flex h-[37px] w-full items-center gap-2.5 rounded-md p-2 text-[13px] font-medium text-[#646a73] transition-colors hover:bg-white/[0.04] hover:text-[#f4f5f7] ${sidebarOpen ? "" : "justify-center"}`}
							>
								<SettingsIcon className="h-[15px] w-[15px]" />
								<span className={sidebarOpen ? "" : "hidden"}>Settings</span>
							</button>
						</div>
					</aside>

					<div className="flex min-w-0 flex-col bg-[#0a0b0d]">
						<div className="flex items-center gap-3 px-[18px] pt-[22px]">
							<div className="flex min-w-0 items-baseline gap-3">
								<h2 className="text-[21px] font-bold tracking-[-0.025em] text-[#f4f5f7]">Board</h2>
								<span className="text-[12.5px] text-[#646a73]">
									Live agent sessions flowing from work → review → merge.
								</span>
							</div>
							<div className="ml-auto flex shrink-0 items-center gap-2">
								<button
									type="button"
									onClick={() => setActiveCard("New task drafted")}
									className="hero-pressable inline-flex h-[34px] items-center gap-1.5 rounded-[7px] border border-[rgba(255,255,255,0.06)] bg-[#1b1d22] px-[15px] text-[13px] font-semibold leading-none text-[#9ba1aa] hover:bg-[#15171b] hover:text-[#f4f5f7]"
								>
									<PlusIcon className="h-3.5 w-3.5" />
									New task
								</button>
								<button
									type="button"
									onClick={() => setActiveCard("Spawn Orchestrator")}
									className="hero-pressable inline-flex h-[34px] items-center gap-1.5 rounded-[7px] bg-[#4d8dff] px-[15px] text-[13px] font-semibold leading-none text-white hover:brightness-110"
								>
									<NetworkIcon className="h-3.5 w-3.5" />
									Spawn Orchestrator
								</button>
							</div>
						</div>

						<div className="min-h-0 flex-1 overflow-hidden p-[18px]">
							<div className="grid h-full grid-cols-4 gap-2">
								{appColumns.map((column) => (
									<section
										key={column.title}
										className="flex min-w-0 flex-col overflow-hidden rounded-[13px]"
										style={{
											background: `linear-gradient(180deg, ${column.glow}, transparent 130px), rgba(255,255,255,0.018)`,
										}}
									>
										<div className="flex shrink-0 items-center gap-[9px] px-[15px] pb-[11px] pt-[14px]">
											<span
												className="h-[7px] w-[7px] rounded-full"
												style={{
													background: column.color,
													boxShadow:
														column.level === "pending"
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
														key={card.title}
														type="button"
														onClick={() => setActiveCard(card.title)}
														className={`w-full rounded-[7px] border bg-[#15171b] text-left transition-colors hover:border-[rgba(255,255,255,0.10)] ${
															activeCard === card.title
																? "border-[rgba(77,141,255,0.48)]"
																: "border-[rgba(255,255,255,0.06)]"
														}`}
													>
														<div className="flex items-center gap-2 px-[13px] pb-[9px] pt-3">
															<span
																className="inline-flex items-center gap-1.5 text-[11px] font-medium"
																style={{ color: card.status === "CI failed" ? "#ef6b6b" : column.color }}
															>
																<span className="h-[7px] w-[7px] rounded-full bg-current" />
																{card.status}
															</span>
															<span className="ml-auto shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-[#646a73]">
																{card.agent}
															</span>
														</div>
														<div className="line-clamp-2 overflow-hidden px-[13px] pb-2 text-[13px] font-medium leading-[1.42] tracking-[-0.01em] text-[#f4f5f7]">
															{card.title}
														</div>
														<div className="px-[13px] pb-2.5 font-mono text-[10.5px] text-[#646a73]">{card.branch}</div>
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
						</div>
						<div className="shrink-0 border-t border-[rgba(255,255,255,0.06)] px-[18px]">
							<div className="flex min-h-[51px] items-center gap-2 py-2 text-[#9ba1aa]">
								<ChevronIcon className="h-3 w-3 text-[#646a73]" />
								<span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.05em]">
									Done / Terminated
								</span>
								<span className="ml-auto shrink-0 font-mono text-[10px] text-[#646a73]">3</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
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
						className="mx-auto max-w-[1120px] font-sans font-[600] leading-[1.08] text-[#f2f3f5]"
						style={{
							fontFamily: '"Instrument Sans", "Inter", "Helvetica Neue", Arial, sans-serif',
							fontSize: "clamp(34px, 3.55vw, 62px)",
							letterSpacing: "-0.026em",
						}}
					>
						<span className="block">Stop babysitting coding agents.</span>
						<span className="mt-2 block italic">
							Start merging <span className="font-[620] text-[#93b4f8]">real work.</span>
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
