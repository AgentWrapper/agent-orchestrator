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
    <div className="landing-reveal text-center px-6 pt-[60px] pb-4">
      <div className="text-[0.6875rem] tracking-[0.2em] uppercase text-[var(--landing-muted)] mb-8 font-mono">
        Works with your favorite AI agents
      </div>
      <div className="flex items-center justify-center gap-8 flex-wrap">
        {agents.map((agent) => (
          <div
            key={agent.name}
            className="group flex flex-col items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300 hover:bg-[var(--landing-border)]"
          >
            <div className="w-10 h-10 rounded-lg bg-[var(--landing-border)] flex items-center justify-center p-2 transition-all duration-300 group-hover:bg-[var(--landing-border-hover)] group-hover:shadow-[0_0_20px_rgba(249,115,22,0.08)]">
              <img
                src={agent.src}
                alt={agent.alt}
                className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-110"
              />
            </div>
            <div className="text-[0.6875rem] font-mono text-[var(--landing-muted)] transition-colors duration-300 group-hover:text-[var(--landing-fg-secondary)]">
              {agent.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
