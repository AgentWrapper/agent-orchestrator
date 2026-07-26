"use client";

type Agent = { name: string; src: string };

// All 23 supported agents, each with its brand logo. Most come from the app's
// agent assets; goose/kilocode use whitened marks and agy (Antigravity) /
// auggie (Augment) / autohand use their own brand favicons so every mark reads
// on the dark background.
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
  { name: "Goose", src: "/app-icons/agents/goose.svg" },
  { name: "Continue", src: "/app-icons/agents/continue.png" },
  { name: "Devin", src: "/app-icons/agents/devin.png" },
  { name: "Kimi", src: "/app-icons/agents/kimi.png" },
  { name: "Kiro", src: "/app-icons/agents/kiro.png" },
  { name: "Kilo Code", src: "/app-icons/agents/kilocode.svg" },
  { name: "Mistral Vibe", src: "/app-icons/agents/vibe.png" },
  { name: "Pi", src: "/app-icons/agents/pi.png" },
  { name: "Amp", src: "/app-icons/agents/amp.svg" },
  { name: "Cline", src: "/app-icons/agents/cline.svg" },
  { name: "Antigravity", src: "/app-icons/agents/agy.png" },
  { name: "Auggie", src: "/app-icons/agents/auggie.svg" },
  { name: "Autohand", src: "/app-icons/agents/autohand.svg" },
];

function AgentMark({ agent }: { agent: Agent }) {
  return (
    <img
      src={agent.src}
      alt={agent.name}
      title={agent.name}
      className="h-8 w-8 shrink-0 object-contain"
      draggable="false"
    />
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

        {/* Narrow viewport so ~10 logos are visible at once as they flow. */}
        <div className="agent-marquee group relative mx-auto w-full max-w-2xl overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
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
