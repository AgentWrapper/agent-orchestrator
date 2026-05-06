const agents = [
  {
    name: "Claude Code",
    src: "/docs/logos/claude-code.svg",
    alt: "Anthropic",
  },
  {
    name: "Codex",
    src: "/docs/logos/codex.svg",
    alt: "OpenAI",
  },
  {
    name: "Cursor",
    src: "/docs/logos/cursor.svg",
    alt: "Cursor",
  },
  {
    name: "Aider",
    src: "https://aider.chat/assets/logo.svg",
    alt: "Aider",
  },
  {
    name: "OpenCode",
    src: "/docs/logos/opencode.svg",
    alt: "OpenCode",
  },
];

export function LandingAgentsBar() {
  return (
    <div className="landing-reveal text-center px-6 pt-[60px]">
      <div className="text-[0.6875rem] tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-40 mb-5">
        Works with your favorite AI agents
      </div>
      <div className="flex items-center justify-center gap-6 flex-wrap">
        {agents.map((agent) => (
          <div key={agent.name} className="flex flex-col items-center gap-2">
            <img
              src={agent.src}
              alt={agent.alt}
              className="w-8 h-8 rounded-md object-contain"
            />
            <div className="text-[0.6875rem] font-mono text-[var(--landing-muted)] opacity-50">
              {agent.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
