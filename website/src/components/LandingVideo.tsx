export function LandingVideo() {
  return (
    <section className="landing-reveal px-6 pb-[120px] pt-10 max-w-[72rem] mx-auto">
      <div className="text-center mb-5">
        <span className="text-[0.6875rem] tracking-[0.12em] uppercase text-[var(--landing-muted)] opacity-50">
          See it in action
        </span>
      </div>
      <div className="landing-card rounded-2xl overflow-hidden aspect-video">
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
