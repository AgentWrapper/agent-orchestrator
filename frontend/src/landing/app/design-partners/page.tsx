import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { LandingFooter } from "../../components/LandingFooter";
import { ScrollRevealProvider } from "../../components/ScrollRevealProvider";

export const metadata: Metadata = {
	title: "Design Partner Program - Agent Orchestrator",
	description:
		"Mission control for your agent fleet: shared sessions, ROI observability, and an engine room your org fully owns. Your engineers get leverage; your leadership gets answers.",
	openGraph: {
		title: "AO Design Partner Program",
		description:
			"Mission control for your agent fleet: shared sessions, ROI observability, and an engine room your org fully owns.",
		url: "https://aoagents.dev/design-partners",
	},
};

const CONTACT_EMAIL = "prateek@untrivial.ai";
const CAL_URL = "https://cal.com/agentwrapper/ao-design-partner";
const MAILTO_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("AO Design Partner Program")}&body=${encodeURIComponent(
	"Hi Prateek,\n\nWe're interested in the AO design partner program.\n\nCompany:\nEngineering team size:\nAgent harnesses we use today (Claude Code / Codex / Cursor / ...):\nWhat we want out of AO:\n",
)}`;

// Paste the Google Form URL here when it exists; the Apply button renders only when set.
const APPLY_FORM_URL: string | null = null;

/* ---------------------------------- icons ---------------------------------- */

type IconProps = { className?: string };

function icon(path: React.ReactNode) {
	return function Icon({ className = "" }: IconProps) {
		return (
			<svg
				className={className}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				{path}
			</svg>
		);
	};
}

/* fleet: terminal window with a prompt */
const FleetIcon = icon(
	<>
		<rect x="3" y="4" width="18" height="16" rx="2" />
		<path d="m7 9 3 3-3 3" />
		<path d="M12.5 15H17" />
	</>,
);

/* shared mission control: sessions branching to people */
const ShareIcon = icon(
	<>
		<circle cx="6" cy="12" r="2.5" />
		<circle cx="18" cy="5.5" r="2.5" />
		<circle cx="18" cy="18.5" r="2.5" />
		<path d="M8.2 10.8 15.8 6.7" />
		<path d="m8.2 13.2 7.6 4.1" />
	</>,
);

/* ROI: pulse over a baseline */
const PulseIcon = icon(
	<>
		<path d="M3 12h4l2.5-6 4 12L16 12h5" />
	</>,
);

/* engine room: shield around a server dot */
const ShieldIcon = icon(
	<>
		<path d="M12 3 5 6v5c0 4.6 3 8 7 10 4-2 7-5.4 7-10V6l-7-3Z" />
		<path d="M9.5 12.5 11.5 14.5 15 10.5" />
	</>,
);

/* white-glove onboarding: wrench */
const WrenchIcon = icon(
	<path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6L14.5 12l-2.5-2.5 2.7-3.2Z" />,
);

/* founder access: chat bubble */
const ChatIcon = icon(<path d="M21 12a8 8 0 0 1-8 8H4l2.3-2.9A8 8 0 1 1 21 12Z" />);

/* book a call: calendar */
const CalendarIcon = icon(
	<>
		<rect x="3" y="5" width="18" height="16" rx="2" />
		<path d="M3 10h18" />
		<path d="M8 3v4" />
		<path d="M16 3v4" />
	</>,
);

/* first access: key */
const KeyIcon = icon(
	<>
		<circle cx="8" cy="15" r="4" />
		<path d="m10.8 12.2 8.7-8.7" />
		<path d="M16.5 6.5 19 9" />
		<path d="m14 9 2 2" />
	</>,
);

/* price lock: tag */
const TagIcon = icon(
	<>
		<path d="M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8L3 11Z" />
		<circle cx="8" cy="8" r="1.4" />
	</>,
);

/* paid pilot: receipt */
const ReceiptIcon = icon(
	<>
		<path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3Z" />
		<path d="M9.5 8.5H15" />
		<path d="M9.5 12H15" />
	</>,
);

/* champion + sponsor: two people */
const PeopleIcon = icon(
	<>
		<circle cx="9" cy="8" r="3" />
		<path d="M3.5 20c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
		<path d="M15.5 5.6a3 3 0 0 1 0 4.8" />
		<path d="M17.5 15.4c1.7.8 2.7 2.4 3 4.6" />
	</>,
);

/* feedback: loop arrows */
const LoopIcon = icon(
	<>
		<path d="M20 8a8 8 0 0 0-14.5-1.5" />
		<path d="M5.5 2.5v4h4" />
		<path d="M4 16a8 8 0 0 0 14.5 1.5" />
		<path d="M18.5 21.5v-4h-4" />
	</>,
);

/* ------------------------------- page content ------------------------------- */

type RoadmapPhase = {
	num: string;
	Icon: React.ComponentType<IconProps>;
	status: string;
	live?: boolean;
	title: string;
	theme: string;
	unlocks: string[];
};

const ROADMAP: RoadmapPhase[] = [
	{
		num: "00",
		Icon: FleetIcon,
		status: "available now",
		live: true,
		title: "A fleet on every desk",
		theme: "The single-player engine. Free, open source, already on your machine.",
		unlocks: [
			"23 harnesses behind one board - Claude Code, Codex, Cursor, and whatever comes next",
			"Every session in its own git worktree; branches never collide",
			"CI failures and review comments route back to the agent that owns the branch",
			"An orchestrator plans the work and spawns the workers",
		],
	},
	{
		num: "01",
		Icon: ShareIcon,
		status: "building now - partners get it first",
		title: "Shared mission control",
		theme: "The fleet becomes a team sport. Execution stays local; coordination moves to one workspace.",
		unlocks: [
			"Team workspaces - the first cloud layer, opt-in by design",
			"Every session durably captured; hand a running fleet to a teammate",
			"One board for the team: running, merged, needs a human",
		],
	},
	{
		num: "02",
		Icon: PulseIcon,
		status: "partners shape the spec",
		title: "The ROI answer",
		theme: "What did the agents ship last week? What did it cost? Answered.",
		unlocks: [
			"Token spend by project, agent, and team",
			"Outcomes, not vibes: agent PRs merged, cycle time, human-rescue rate",
			"Transcripts joined with GitHub, CI, reviews, and trackers - reviewable in one place",
		],
	},
	{
		num: "03",
		Icon: ShieldIcon,
		status: "scoped with partners who need it",
		title: "The engine room",
		theme: "The whole engine inside your walls. Your sandboxes. Your policies. Your data.",
		unlocks: [
			"Self-hosted control plane in your VPC",
			"Security policies enforced on every agent; audit trails and SSO across the fleet",
			"The dataset stays yours: full transcripts joined with SCM, CI, and tracker history",
		],
	},
];

const OFFER = [
	{
		Icon: WrenchIcon,
		title: "White-glove onboarding",
		body: "Founder-led setup on your real repos, with the agents you already pay for.",
	},
	{
		Icon: ChatIcon,
		title: "Weekly founder access",
		body: "A standing call and a private channel. Your bugs jump a queue that ships nightly.",
	},
	{
		Icon: KeyIcon,
		title: "First access to every unlock",
		body: "Teams features land in your workspace before anyone else's.",
	},
	{
		Icon: TagIcon,
		title: "Locked-in pricing",
		body: "Six months of partner pricing at GA. Pilot fees credit toward year one.",
	},
];

const ASK = [
	{
		Icon: ReceiptIcon,
		title: "A paid pilot",
		body: "$500-2,000/month, sized to usage. Month-to-month. Churn is honest signal.",
	},
	{
		Icon: PeopleIcon,
		title: "A champion and a sponsor",
		body: "One engineer who runs AO weekly. One leader who wants the ROI answer.",
	},
	{
		Icon: LoopIcon,
		title: "Real feedback",
		body: "A biweekly working session and honest numbers - including the bad news.",
	},
];

const STATS = [
	{ value: "8,400+", label: "stars in 5 months" },
	{ value: "1,200+", label: "forks" },
	{ value: "23", label: "agent harnesses" },
	{ value: "Nightly", label: "desktop releases" },
];

function DotFact({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-[color:var(--fg-dim)]">
			<span className="h-1 w-1 rounded-full bg-[color:var(--accent)]" aria-hidden="true" />
			{children}
		</span>
	);
}

function ChevronIcon({ className = "" }: IconProps) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m9 6 6 6-6 6" />
		</svg>
	);
}

function PartnersNav() {
	return (
		<header className="border-b border-[color:var(--border)]">
			<div className="container-page flex h-16 items-center justify-between">
				<Link href="/" className="inline-flex items-center gap-3">
					<Image
						src="/ao-logo-transparent.png"
						alt="Agent Orchestrator"
						width={32}
						height={32}
						className="h-8 w-8 object-contain"
					/>
					<span className="text-[15px] font-semibold text-[color:var(--fg)]">Agent Orchestrator</span>
				</Link>
				<nav className="flex items-center gap-5">
					<Link href="/" className="landing-nav-link hidden text-[13px] font-medium sm:inline-block">
						Home
					</Link>
					<a
						href="https://github.com/AgentWrapper/agent-orchestrator"
						target="_blank"
						rel="noreferrer"
						className="landing-nav-link hidden text-[13px] font-medium sm:inline-block"
					>
						GitHub
					</a>
					<a
						href={CAL_URL}
						target="_blank"
						rel="noreferrer"
						className="hero-pressable btn-primary inline-flex h-9 items-center justify-center rounded-[6px] px-4 text-[13px] font-semibold"
					>
						Book a discovery call
					</a>
				</nav>
			</div>
		</header>
	);
}

export default function DesignPartnersPage() {
	return (
		<ScrollRevealProvider>
			<div className="landing-page relative z-10 min-h-dvh">
				<PartnersNav />

				{/* Hero */}
				<section className="relative overflow-hidden pt-[clamp(80px,10vw,140px)] pb-[clamp(64px,8vw,100px)]">
					<div
						className="pointer-events-none absolute inset-0"
						style={{ background: "radial-gradient(ellipse 60% 50% at 50% 0%, var(--accent-soft), transparent 70%)" }}
					/>
					<div className="container-page relative">
						<div className="mx-auto max-w-[860px] text-center">
							<div className="landing-eyebrow mb-5">Design partner program</div>
							<h1 className="landing-hero-heading mx-auto" style={{ fontSize: "clamp(36px, 5vw, 68px)" }}>
								<span className="landing-hero-heading-setup block">Your company is the car.</span>
								<span className="landing-hero-heading-action block">
									We build the <span className="landing-hero-heading-accent">engine.</span>
								</span>
							</h1>
							<p className="mx-auto mt-6 max-w-[560px] text-balance text-[16px] leading-[1.65] text-[color:var(--fg-muted)] sm:text-[17px]">
								Your engineers already run coding agents. Nobody runs the fleet. AO puts every agent, branch, and PR on
								one board and routes CI failures and review comments back to the agent that owns them. More merged work
								from the subscriptions you already pay for.
							</p>
							<div className="mt-9 flex w-full flex-col items-stretch justify-center gap-3 sm:w-auto sm:flex-row sm:items-center">
								<a
									href={CAL_URL}
									target="_blank"
									rel="noreferrer"
									className="hero-pressable btn-primary inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] px-7 text-[15px] font-semibold sm:w-auto"
								>
									<CalendarIcon className="h-4 w-4" />
									Book a discovery call
								</a>
								{APPLY_FORM_URL ? (
									<a
										href={APPLY_FORM_URL}
										target="_blank"
										rel="noreferrer"
										className="hero-pressable inline-flex h-12 w-full items-center justify-center gap-2 rounded-[6px] border border-[color:var(--border-strong)] bg-transparent px-7 text-[15px] font-semibold text-[color:var(--fg)] hover:border-[color:var(--accent-glow)] hover:bg-[color:var(--bg-card-hover)] sm:w-auto"
									>
										Apply via form
									</a>
								) : null}
							</div>
							<p className="mt-4 text-[13px] text-[color:var(--fg-dim)]">
								or write to{" "}
								<a
									href={MAILTO_HREF}
									className="text-[color:var(--fg-muted)] underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-[color:var(--fg)]"
								>
									{CONTACT_EMAIL}
								</a>
							</p>
							<div className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
								<DotFact>paid pilots</DotFact>
								<DotFact>month-to-month</DotFact>
								<DotFact>cancel anytime</DotFact>
							</div>
						</div>
					</div>
				</section>

				{/* Proof strip */}
				<section className="landing-reveal border-y border-[color:var(--border)]">
					<div className="container-page">
						<div className="grid grid-cols-2 divide-[color:var(--border)] sm:grid-cols-4 sm:divide-x">
							{STATS.map((stat) => (
								<div key={stat.label} className="px-4 py-8 text-center">
									<div className="font-editorial text-[30px] font-semibold tracking-tight text-[color:var(--fg)]">
										{stat.value}
									</div>
									<div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-dim)]">
										{stat.label}
									</div>
								</div>
							))}
						</div>
					</div>
				</section>

				{/* Roadmap - timeline with progressive disclosure */}
				<section className="relative overflow-hidden py-[clamp(72px,9vw,120px)]">
					<div
						className="pointer-events-none absolute inset-0"
						style={{ background: "radial-gradient(ellipse 50% 40% at 50% 35%, var(--accent-soft), transparent 75%)" }}
					/>
					<div className="container-page relative">
						<div className="landing-reveal mx-auto max-w-[860px]">
							<div className="landing-eyebrow mb-4">What your team gets</div>
							<h2 className="landing-heading">
								One workspace. Humans and agents, <span className="landing-heading-muted">side by side.</span>
							</h2>
							<p className="landing-body-compact mt-5 max-w-[58ch]">
								Every session shareable. Every outcome measurable. Every transcript captured - and owned by your org.
								Each layer lands in partner workspaces first.
							</p>
						</div>

						<div className="relative mx-auto mt-14 max-w-[860px]">
							{/* timeline rail */}
							<div
								className="pointer-events-none absolute bottom-6 left-[39.5px] top-6 hidden w-px sm:block"
								style={{ background: "linear-gradient(to bottom, var(--accent-glow), var(--border) 60%, transparent)" }}
								aria-hidden="true"
							/>
							<div className="space-y-3">
								{ROADMAP.map((phase, i) => (
									<details key={phase.num} className="landing-reveal group relative" open={i === 0}>
										<summary className="flex cursor-pointer list-none items-start gap-5 rounded-xl p-3 transition-colors hover:bg-white/[0.02] [&::-webkit-details-marker]:hidden sm:p-4">
											{/* timeline node */}
											<span
												className={`relative z-10 hidden h-12 w-12 shrink-0 items-center justify-center rounded-[10px] border sm:flex ${
													phase.live
														? "border-[color:var(--accent-glow)] bg-[color:var(--accent-soft)] text-[color:var(--accent)]"
														: "border-[color:var(--border-strong)] bg-[color:var(--bg)] text-[color:var(--fg-muted)]"
												}`}
											>
												<phase.Icon className="h-5 w-5" />
											</span>
											<span className="min-w-0 flex-1 pt-0.5">
												<span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
													<span className="font-mono text-[11px] tracking-[0.14em] text-[color:var(--fg-dim)]">
														{phase.num}
													</span>
													<span className="text-[18px] font-semibold tracking-[-0.01em] text-[color:var(--fg)] sm:text-[20px]">
														{phase.title}
													</span>
													<span
														className={`font-mono text-[10px] uppercase tracking-[0.12em] ${
															phase.live ? "text-[rgba(134,239,172,0.85)]" : "text-[color:var(--fg-dim)]"
														}`}
													>
														<span
															className={`mr-1.5 inline-block h-1 w-1 -translate-y-px rounded-full align-middle ${phase.live ? "bg-[rgba(134,239,172,0.85)] shadow-[0_0_6px_rgba(134,239,172,0.6)]" : "bg-[color:var(--fg-dim)]"}`}
															aria-hidden="true"
														/>
														{phase.status}
													</span>
												</span>
												<span className="mt-1 block text-[14px] leading-[1.6] text-[color:var(--fg-muted)]">
													{phase.theme}
												</span>
											</span>
											<ChevronIcon className="mt-2 h-4 w-4 shrink-0 text-[color:var(--fg-dim)] transition-transform duration-200 group-open:rotate-90" />
										</summary>
										<div className="pb-4 pl-3 pr-10 sm:pl-[84px]">
											<ul className="space-y-2 border-l border-[color:var(--border)] pl-5">
												{phase.unlocks.map((unlock) => (
													<li key={unlock} className="text-[13.5px] leading-[1.65] text-[color:var(--fg-muted)]">
														{unlock}
													</li>
												))}
											</ul>
										</div>
									</details>
								))}
							</div>
						</div>
					</div>
				</section>

				{/* The exchange */}
				<section className="border-t border-[color:var(--border)] py-[clamp(72px,9vw,120px)]">
					<div className="container-page">
						<div className="landing-reveal mx-auto max-w-[860px]">
							<div className="landing-eyebrow mb-4">The exchange</div>
							<h2 className="landing-heading">
								What you get. <span className="landing-heading-muted">What we ask.</span>
							</h2>
						</div>
						<div className="mx-auto mt-12 grid max-w-[860px] gap-x-16 gap-y-12 sm:grid-cols-2">
							<div>
								<div className="landing-eyebrow landing-eyebrow-accent mb-6">You get</div>
								<ul className="space-y-7">
									{OFFER.map((item) => (
										<li key={item.title} className="landing-reveal flex gap-4">
											<item.Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[color:var(--accent)]" />
											<div>
												<div className="text-[14.5px] font-semibold text-[color:var(--fg)]">{item.title}</div>
												<p className="mt-1 text-[13.5px] leading-[1.65] text-[color:var(--fg-muted)]">{item.body}</p>
											</div>
										</li>
									))}
								</ul>
							</div>
							<div>
								<div className="landing-eyebrow mb-6">We ask</div>
								<ul className="space-y-7">
									{ASK.map((item) => (
										<li key={item.title} className="landing-reveal flex gap-4">
											<item.Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-[color:var(--fg-muted)]" />
											<div>
												<div className="text-[14.5px] font-semibold text-[color:var(--fg)]">{item.title}</div>
												<p className="mt-1 text-[13.5px] leading-[1.65] text-[color:var(--fg-muted)]">{item.body}</p>
											</div>
										</li>
									))}
								</ul>
							</div>
						</div>
						<div className="landing-reveal mx-auto mt-14 max-w-[860px] border-t border-[color:var(--border)] pt-6">
							<p className="text-[13.5px] leading-[1.7] text-[color:var(--fg-dim)]">
								Best fit: 10-100 engineers. Multiple agent subscriptions in use. Leadership asking what the spend
								produces. AO ships a new build every night - what we promise, you watch arrive.
							</p>
						</div>
					</div>
				</section>

				{/* Posture + CTA */}
				<section className="relative overflow-hidden border-t border-[color:var(--border)] py-[clamp(80px,10vw,130px)]">
					<div
						className="pointer-events-none absolute inset-0"
						style={{ background: "radial-gradient(ellipse 60% 55% at 50% 62%, var(--accent-soft), transparent 70%)" }}
					/>
					<div className="container-page relative">
						<div className="landing-reveal mx-auto max-w-[860px] text-center">
							<h2 className="landing-hero-heading mx-auto" style={{ fontSize: "clamp(30px, 4.2vw, 58px)" }}>
								<span className="landing-hero-heading-setup block">Your engineers get leverage.</span>
								<span className="landing-hero-heading-action block">
									Your leadership gets <span className="landing-hero-heading-accent">answers.</span>
								</span>
							</h2>
							<div className="mt-9 flex justify-center">
								<a
									href={CAL_URL}
									target="_blank"
									rel="noreferrer"
									className="hero-pressable btn-primary inline-flex h-12 items-center justify-center gap-2 rounded-[6px] px-7 text-[15px] font-semibold"
								>
									<CalendarIcon className="h-4 w-4" />
									Book a discovery call
								</a>
							</div>
							<p className="mt-4 text-[13px] text-[color:var(--fg-dim)]">
								or write to{" "}
								<a
									href={MAILTO_HREF}
									className="text-[color:var(--fg-muted)] underline decoration-[color:var(--border-strong)] underline-offset-4 transition-colors hover:text-[color:var(--fg)]"
								>
									{CONTACT_EMAIL}
								</a>
							</p>
						</div>
					</div>
				</section>

				<LandingFooter />
			</div>
		</ScrollRevealProvider>
	);
}
