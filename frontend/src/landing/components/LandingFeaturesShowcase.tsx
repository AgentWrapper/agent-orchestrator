import Image from "next/image";

type Feature = {
	eyebrow: string;
	title: string;
	body: string;
	facts: string[];
	src: string;
	alt: string;
	width: number;
	height: number;
};

const features: Feature[] = [
	{
		eyebrow: "Delegate",
		title: "Tell the orchestrator what you need.",
		body: "Every project gets a main agent that runs the fleet for you. Describe the outcome — it plans the work, spawns workers into their own worktrees, keeps them moving, and escalates only what needs a human.",
		facts: ["plans + spawns workers", "keeps sessions moving", "you stay the reviewer"],
		src: "/features/orchestrator.jpg",
		alt: "A real orchestrator session in AO: the user asks it to plan tasks from the backlog, and the orchestrator answers with a triage, a plan table, and spawns the workers.",
		width: 1600,
		height: 565,
	},
	{
		eyebrow: "Watch",
		title: "The whole fleet, at a glance.",
		body: "Every session flows across one board — working, needs you, in review, ready to merge — with its agent, branch, and PR state on the card. You see what needs attention and ignore the rest.",
		facts: ["live session status", "PR + CI state per card", "multi-project"],
		src: "/features/board-fleet.jpg",
		alt: "The AO board with real sessions across four columns — Working, Needs you, In review, Ready to merge — each card showing its task, agent, branch, and pull request state.",
		width: 1600,
		height: 674,
	},
	{
		eyebrow: "Close the loop",
		title: "CI fails. The right agent hears about it.",
		body: "AO watches every PR it opens. Failed checks and review comments route back to the session that owns the branch — with the context to fix them — until the PR is approved.",
		facts: ["CI + review routing", "full activity timeline", "one click to the PR"],
		src: "/features/session-feedback.jpg",
		alt: "A session inspector in AO: a real Codex terminal that just received AO's message about CI failing on its pull request, next to the pull request card and activity timeline.",
		width: 1600,
		height: 811,
	},
];

export function LandingFeaturesShowcase() {
	return (
		<section
			id="features"
			data-testid="features-showcase"
			className="relative border-t border-[color:var(--border)] pt-16 pb-20 sm:pt-[clamp(80px,9vw,128px)] sm:pb-[clamp(90px,10vw,140px)]"
		>
			<div className="container-page">
				<div className="mx-auto max-w-[1180px]">
					<div className="max-w-[720px]">
						<div className="landing-eyebrow mb-4">How it works</div>
						<h2 className="landing-heading">
							From a one-line task <span className="landing-heading-muted">to a merged PR.</span>
						</h2>
						<p className="landing-body-compact mt-5">Everything below is the actual AO desktop app, doing real work.</p>
					</div>

					<div className="mt-16 flex flex-col gap-20 sm:mt-20 sm:gap-28">
						{features.map((feature, index) => {
							const flip = index % 2 === 1;
							return (
								<div key={feature.title} className="landing-reveal grid items-center gap-8 lg:grid-cols-12 lg:gap-12">
									<div className={`lg:col-span-5 ${flip ? "lg:order-2" : ""}`}>
										<div className="landing-eyebrow landing-eyebrow-accent">{feature.eyebrow}</div>
										<h3 className="mt-3 text-[26px] font-semibold leading-[1.15] tracking-[-0.02em] text-[color:var(--fg)] sm:text-[32px]">
											{feature.title}
										</h3>
										<p className="mt-4 max-w-[46ch] text-[15px] leading-[1.7] text-[color:var(--fg-muted)]">
											{feature.body}
										</p>
										<div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.1em] text-[color:var(--fg-dim)]">
											{feature.facts.map((fact) => (
												<span key={fact} className="inline-flex items-center gap-2">
													<span className="h-1 w-1 rounded-full bg-[color:var(--accent)]" aria-hidden="true" />
													{fact}
												</span>
											))}
										</div>
									</div>
									<div className={`relative lg:col-span-7 ${flip ? "lg:order-1" : ""}`}>
										<div className="pointer-events-none absolute -inset-4 rounded-2xl bg-[color:var(--accent)] opacity-[0.03] blur-2xl" />
										<div className="hero-laptop-screen relative">
											<div className="hero-laptop-display">
												<Image
													src={feature.src}
													alt={feature.alt}
													width={feature.width}
													height={feature.height}
													className="h-auto w-full"
													sizes="(min-width: 1024px) 660px, 100vw"
												/>
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</section>
	);
}
