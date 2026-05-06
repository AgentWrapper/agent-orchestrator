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
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          What engineers say
        </div>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-1.5px] mb-6">
          Trusted by <em className="italic text-[var(--landing-muted)]">builders</em>
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-12">
        {testimonials.map((t) => (
          <div key={t.initials} className="landing-reveal landing-card rounded-2xl p-8">
            <p className="text-[0.9375rem] text-[var(--landing-fg)]/80 leading-[1.7] mb-5 italic font-sans font-[680] tracking-tight">
              &ldquo;{t.quote}&rdquo;
            </p>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[var(--landing-surface)] flex items-center justify-center text-xs font-semibold text-[var(--landing-muted)]">
                {t.initials}
              </div>
              <div>
                <div className="text-[0.8125rem] font-medium">{t.name}</div>
                <div className="text-[0.6875rem] text-[var(--landing-muted)] opacity-60">
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
