const testimonials = [
  {
    quote:
      "Set up 12 agents on our backlog before lunch. By end of day, 8 PRs were merged.",
    initials: "01",
    name: "Staff Engineer",
    role: "Series B Startup",
  },
  {
    quote:
      "The auto CI recovery alone saves me hours a week. Agents fix their own broken tests. I just review and merge.",
    initials: "02",
    name: "Solo Founder",
    role: "Indie SaaS",
  },
  {
    quote:
      "We went from 3 PRs/day to 15 PRs/day. The plugin system means we swapped in GitLab and Linear without changing our workflow.",
    initials: "03",
    name: "Eng Lead",
    role: "20-person team",
  },
];

export function LandingTestimonials() {
  return (
    <section className="py-20 px-6 pb-[120px] max-w-[72rem] mx-auto">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.2em] uppercase text-[var(--accent-blue)] mb-4 font-mono font-medium">
          What engineers say
        </div>
        <h2 className="font-sans font-[680] tracking-tight text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-1.5px] text-gradient-blue">
          Trusted by <em className="italic text-[var(--landing-fg-secondary)]">builders</em>
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-12 stagger-children">
        {testimonials.map((t) => (
          <div key={t.initials} className="landing-reveal glow-card rounded-2xl p-8 flex flex-col justify-between">
            <div>
              <div className="text-[var(--accent-blue)] text-2xl mb-4 leading-none select-none">&ldquo;</div>
              <p className="text-[0.9375rem] text-[var(--landing-fg-secondary)] leading-[1.7] mb-6 italic">
                {t.quote}
              </p>
            </div>
            <div className="flex items-center gap-3 pt-4 border-t border-[var(--landing-border)]">
              <div className="w-9 h-9 rounded-full bg-[rgba(59,130,246,0.08)] border border-[rgba(59,130,246,0.15)] flex items-center justify-center text-xs font-mono font-semibold text-[var(--accent-blue)]">
                {t.initials}
              </div>
              <div>
                <div className="text-[0.8125rem] font-medium text-[var(--landing-fg)]">{t.name}</div>
                <div className="text-[0.6875rem] text-[var(--landing-muted)]">
                  {t.role}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
