"use client";

const SUPPORTED_APP_ICONS = [
  { name: "Claude", src: "/app-icons/claude.svg" },
  { name: "Codex", src: "/app-icons/codex.svg" },
  { name: "OpenCode", src: "/app-icons/opencode.svg" },
  { name: "Cursor", src: "/app-icons/cursor.svg" },
  { name: "Copilot", src: "/app-icons/copilot-white.svg" },
  { name: "Gemini", src: "/app-icons/gemini.svg" },
  { name: "Amp", src: "/app-icons/amp.svg" },
  { name: "Mistral Vibe", src: "/app-icons/vibe.svg" },
  { name: "Kimi Code", src: "/app-icons/kimi.svg" },
  { name: "Pi Agent", src: "/app-icons/pi-white.svg" },
  { name: "MastraCode", src: "/app-icons/mastracode-white.svg" },
  { name: "JetBrains", src: "/app-icons/jetbrains.svg" },
];

export function TrustedBySection() {
  return (
    <section className="py-16 sm:py-24 bg-background overflow-hidden">
      <div className="max-w-7xl mx-auto text-center">
        <h2 className="mx-auto mb-12 max-w-3xl select-none px-4 text-3xl font-semibold text-foreground sm:px-8 sm:text-4xl lg:px-[30px] lg:text-5xl">
          Use the agents you already trust.
        </h2>

        <div className="mx-auto flex w-full max-w-6xl flex-row flex-wrap items-center justify-center gap-x-6 gap-y-5 px-4 sm:gap-5 sm:px-8">
          {SUPPORTED_APP_ICONS.map((app) => (
            <img
              key={app.name}
              src={app.src}
              alt={app.name}
              className="h-8 w-8 shrink-0 object-contain"
              loading="lazy"
              draggable="false"
            />
          ))}
        </div>
      </div>
    </section>
  );
}
