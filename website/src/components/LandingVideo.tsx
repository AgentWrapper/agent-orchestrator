export function LandingVideo() {
  return (
    <section className="landing-reveal px-6 pb-[140px] pt-10 max-w-[72rem] mx-auto">
      <div className="text-center mb-6">
        <span className="font-mono text-[0.75rem] tracking-[0.2em] uppercase text-[var(--accent-orange)]">
          See it in action
        </span>
      </div>
      <div className="glow-card rounded-2xl overflow-hidden aspect-video" style={{
        boxShadow: "0 0 80px -20px rgba(249,115,22,0.1)"
      }}>
        <iframe
          src="https://www.youtube.com/embed/QdwaeEXOmDs?autoplay=0&rel=0&modestbranding=1"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="w-full h-full border-none"
          title="Agent Orchestrator Launch Demo"
        />
      </div>
    </section>
  );
}
