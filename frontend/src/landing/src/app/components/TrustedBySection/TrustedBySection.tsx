"use client";

type Agent = { name: string; src?: string; mono?: string };

// All 23 supported agents. Twenty ship a brand logo (copied from the app's agent
// assets); agy/auggie/autohand have no brand mark yet, so they show a monogram
// chip in the same footprint.
const AGENTS: Agent[] = [
  { name: "Claude Code", src: "/app-icons/agents/claude-code.svg" },
  { name: "Codex", src: "/app-icons/agents/codex.svg" },
  { name: "Cursor", src: "/app-icons/agents/cursor.svg" },
  { name: "OpenCode", src: "/app-icons/agents/opencode.svg" },
  { name: "Copilot", src: "/app-icons/agents/copilot.png" },
  { name: "Aider", src: "/app-icons/agents/aider.png" },
  { name: "Grok", src: "/app-icons/agents/grok.png" },
  { name: "Droid", src: "/app-icons/agents/droid.png" },
  { name: "Crush", src: "/app-icons/agents/crush.png" },
  { name: "Qwen", src: "/app-icons/agents/qwen.png" },
  { name: "Goose", src: "/app-icons/agents/goose.png" },
  { name: "Continue", src: "/app-icons/agents/continue.png" },
  { name: "Devin", src: "/app-icons/agents/devin.png" },
  { name: "Kimi", src: "/app-icons/agents/kimi.png" },
  { name: "Kiro", src: "/app-icons/agents/kiro.png" },
  { name: "Kilo Code", src: "/app-icons/agents/kilocode.png" },
  { name: "Mistral Vibe", src: "/app-icons/agents/vibe.png" },
  { name: "Pi", src: "/app-icons/agents/pi.png" },
  { name: "Amp", src: "/app-icons/agents/amp.svg" },
  { name: "Cline", src: "/app-icons/agents/cline.svg" },
  { name: "Agy", mono: "ag" },
  { name: "Auggie", mono: "au" },
  { name: "Autohand", mono: "ah" },
];

function AgentMark({ agent }: { agent: Agent }) {
  if (agent.src) {
    return (
      <img
        src={agent.src}
        alt={agent.name}
        title={agent.name}
        className="h-8 w-8 shrink-0 object-contain"
        loading="lazy"
        draggable="false"
      />
    );
  }
  return (
    <span
      title={agent.name}
      aria-label={agent.name}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/15 text-xs font-semibold uppercase tracking-tight text-white/55"
    >
      {agent.mono}
    </span>
  );
}

export function TrustedBySection() {
  // Two copies of the list, translated by -50%, give a seamless infinite loop.
  const loop = [...AGENTS, ...AGENTS];
  return (
    <section className="py-16 sm:py-24 bg-background overflow-hidden">
      <div className="max-w-7xl mx-auto text-center">
        <h2 className="mx-auto mb-12 max-w-3xl select-none px-4 text-3xl font-semibold text-foreground sm:px-8 sm:text-4xl lg:px-[30px] lg:text-5xl">
          Use the agents you already trust.
        </h2>

        <div className="agent-marquee group relative w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
          <div className="agent-marquee__track flex w-max items-center gap-8 sm:gap-10">
            {loop.map((agent, i) => (
              <AgentMark key={`${agent.name}-${i}`} agent={agent} />
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes agent-marquee-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .agent-marquee__track {
          animation: agent-marquee-scroll 45s linear infinite;
          will-change: transform;
        }
        .agent-marquee:hover .agent-marquee__track {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .agent-marquee__track { animation: none; }
        }
      `}</style>
    </section>
  );
}
