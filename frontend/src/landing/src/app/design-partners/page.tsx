import { COMPANY } from "@superset/shared/constants";
import type { Metadata } from "next";

const CONTACT_EMAIL = "prateek@untrivial.ai";
const CAL_URL = "https://cal.com/agentwrapper/ao-design-partner";
const MAILTO_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
  "AO Design Partner Program",
)}&body=${encodeURIComponent(
  "Hi Prateek,\n\nWe're interested in the AO design partner program.\n\nCompany:\nEngineering team size:\nAgent harnesses we use today:\nWhat we want out of AO:\n",
)}`;

export const metadata: Metadata = {
  title: "Design Partners",
  description:
    "Work with AO to shape the operating layer for AI software engineering teams.",
  alternates: {
    canonical: `${COMPANY.MARKETING_URL}/design-partners`,
  },
};

const outcomes = [
  {
    title: "A stable layer under every agent",
    body: "Claude Code, Codex, Cursor, and the next harness can all change. Your company keeps one operating model for assigning, reviewing, and learning from agent work.",
  },
  {
    title: "Visibility leadership can trust",
    body: "See what agents shipped, where they got stuck, which teams are getting value, and which workflows should become standard.",
  },
  {
    title: "Context that compounds",
    body: "Every review, fix, failure, and decision becomes part of the organization's engineering memory instead of disappearing inside one terminal session.",
  },
];

const partnerGets = [
  "Founder-led onboarding on real repos and real harnesses.",
  "First access to team workspaces, analytics, and policy controls.",
  "A direct feedback loop while product decisions are still malleable.",
  "Partner pricing that carries into the first commercial release.",
];

const partnerAsks = [
  "A team already using coding agents in production work.",
  "One engineering champion who runs AO weekly.",
  "One leader who wants the ROI answer, not just agent enthusiasm.",
  "Honest feedback, including the workflows that fail.",
];

const phases = [
  {
    label: "Now",
    title: "Local agent fleet",
    body: "Run multiple agents in isolated worktrees, keep branches separated, and route CI or review feedback back to the session that owns the work.",
  },
  {
    label: "Next",
    title: "Shared mission control",
    body: "Turn solo orchestration into a team surface where sessions can be handed off, reviewed, and understood without rebuilding context.",
  },
  {
    label: "Then",
    title: "Company memory",
    body: "Join transcripts, GitHub, CI, reviews, and tracker history so the organization learns from every AI-assisted engineering session.",
  },
];

function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm font-medium tracking-[-0.5px] text-muted-foreground">
      {children}
    </p>
  );
}

function TextLink({
  children,
  href,
}: {
  children: React.ReactNode;
  href: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-11 items-center gap-2 text-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      {children}
    </a>
  );
}

export default function DesignPartnersPage() {
  return (
    <main className="bg-background text-foreground">
      <section className="relative overflow-hidden px-4 pb-20 pt-24 sm:px-8 sm:pb-28 sm:pt-32 lg:px-[30px] lg:pt-36">
        <div className="relative mx-auto max-w-7xl">
          <div className="max-w-5xl">
            <SectionLabel>Design partners</SectionLabel>
            <h1 className="mt-5 max-w-5xl text-balance font-sans text-4xl font-normal leading-[0.98] tracking-[-0.5px] text-foreground sm:text-5xl md:text-6xl lg:text-[4.75rem]">
              Help shape the operating layer for AI software engineering.
            </h1>
            <p className="mt-6 max-w-3xl text-base leading-8 text-muted-foreground sm:text-xl">
              AO is not another model or coding agent. It is the layer underneath
              them, the way teams coordinate agent work, govern how it is used,
              and keep the knowledge those sessions create.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href={CAL_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-3xl bg-foreground px-6 py-3 text-base font-semibold tracking-[-0.5px] text-background transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background motion-reduce:transition-none"
              >
                Book a discovery call
                <ArrowIcon className="h-4 w-4" />
              </a>
              <a
                href={MAILTO_HREF}
                className="inline-flex min-h-11 items-center gap-2 rounded-3xl border border-border bg-background px-6 py-3 text-base font-normal tracking-[-0.5px] text-foreground transition-[transform,background-color] duration-150 hover:bg-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background motion-reduce:transition-none"
              >
                Email us
              </a>
            </div>
          </div>

          <div className="mt-16 grid gap-8 md:grid-cols-3">
            {outcomes.map((item) => (
              <div
                key={item.title}
                className="py-6"
              >
                <h2 className="text-xl font-medium tracking-[-0.5px] text-foreground">
                  {item.title}
                </h2>
                <p className="mt-4 text-sm leading-7 text-muted-foreground">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border px-4 py-16 sm:px-8 sm:py-20 lg:px-[30px]">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div>
            <SectionLabel>Why now</SectionLabel>
            <h2 className="mt-4 max-w-2xl text-3xl font-medium leading-tight tracking-[-0.5px] text-foreground sm:text-4xl lg:text-5xl">
              Adoption was the easy part. Operating it is the hard part.
            </h2>
          </div>
          <div className="space-y-6 text-base leading-8 text-muted-foreground">
            <p>
              Every company using AI is generating thousands of engineering
              sessions. Those sessions contain reasoning, failed attempts,
              debugging paths, review decisions, and context that made the final
              code possible.
            </p>
            <p>
              Today most of that vanishes. Teams keep the code and lose the
              learning. AO turns agent work from temporary output into company
              knowledge that compounds.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-border px-4 py-16 sm:px-8 sm:py-20 lg:px-[30px]">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <SectionLabel>Program shape</SectionLabel>
            <h2 className="mt-4 text-3xl font-medium leading-tight tracking-[-0.5px] text-foreground sm:text-4xl lg:text-5xl">
              Work with us while the system is still being formed.
            </h2>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="py-4 text-base font-medium tracking-[-0.5px] text-foreground">
                You get
              </p>
              <ul>
                {partnerGets.map((item) => (
                  <li key={item} className="py-4 text-sm leading-7 text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="py-4 text-base font-medium tracking-[-0.5px] text-foreground">
                We ask
              </p>
              <ul>
                {partnerAsks.map((item) => (
                  <li key={item} className="py-4 text-sm leading-7 text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-border px-4 py-16 sm:px-8 sm:py-20 lg:px-[30px]">
        <div className="mx-auto max-w-7xl">
          <SectionLabel>Roadmap</SectionLabel>
          <div className="mt-8 grid gap-8 md:grid-cols-3">
            {phases.map((phase) => (
              <article
                key={phase.title}
                className="py-6"
              >
                <p className="text-sm font-medium tracking-[-0.5px] text-muted-foreground">
                  {phase.label}
                </p>
                <h2 className="mt-4 text-2xl font-medium tracking-[-0.5px] text-foreground">
                  {phase.title}
                </h2>
                <p className="mt-4 text-sm leading-7 text-muted-foreground">
                  {phase.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border px-4 py-16 sm:px-8 sm:py-20 lg:px-[30px]">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 py-8 lg:flex-row lg:items-center">
          <div>
            <SectionLabel>Start with your real repos</SectionLabel>
            <h2 className="mt-4 max-w-3xl text-3xl font-medium leading-tight tracking-[-0.5px] text-foreground sm:text-4xl">
              Bring the agents your team already uses. We will help you turn them into one operating system.
            </h2>
          </div>
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
            <a
              href={CAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-3xl bg-foreground px-6 py-3 text-base font-semibold tracking-[-0.5px] text-background transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background motion-reduce:transition-none"
            >
              Book a call
            </a>
            <TextLink href={MAILTO_HREF}>{CONTACT_EMAIL}</TextLink>
          </div>
        </div>
      </section>
    </main>
  );
}
