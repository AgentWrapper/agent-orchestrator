export function LandingHowItWorks() {
  return (
    <section className="py-[120px] px-6 max-w-[72rem] mx-auto" id="how">
      <div className="landing-reveal">
        <div className="text-xs tracking-[0.15em] uppercase text-[var(--landing-muted)] opacity-60 mb-6">
          Process
        </div>
        <h2 className="font-sans font-[680] tracking-tight font-normal text-[clamp(1.375rem,3vw,2rem)] leading-[1.05] tracking-[-1.5px] mb-6">
          Three steps to{" "}
          <em className="italic text-[var(--landing-muted)]">orchestration</em>
        </h2>
      </div>

      <div className="mt-20 flex flex-col gap-20">
        {/* Step 1 */}
        <div className="landing-reveal grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-xs tracking-[0.1em] text-[var(--landing-muted)] opacity-50 mb-4">01</div>
            <h3 className="font-sans font-[680] tracking-tight text-lg tracking-tight mb-4">
              Configure &amp; <em className="italic text-[var(--landing-muted)]">assign</em>
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.7] max-w-[28rem]">
              Point Agent Orchestrator at your repo with a YAML config. Choose your agent, set up trackers and notifiers. One file, full control.
            </p>
          </div>
          <div className="landing-card rounded-2xl p-8 min-h-[260px]">
            <div className="bg-black/40 rounded-xl overflow-hidden font-mono text-[0.8125rem]">
              <div className="flex items-center gap-2 px-4 py-3 bg-[var(--landing-surface)]">
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
              </div>
              <div className="px-5 py-4 leading-[1.8]">
                <div><span className="text-[var(--landing-muted)]">$</span> <span className="text-white">ao batch-spawn 42 43 44 45 46</span></div>
                <div className="text-[var(--landing-muted)] opacity-60">&nbsp;</div>
                <div className="text-[var(--landing-muted)] opacity-60">⟡ Loading config from agent-orchestrator.yaml</div>
                <div className="text-[var(--landing-muted)] opacity-60">⟡ Resolving 5 issues from GitHub</div>
                <div className="text-[var(--landing-muted)] opacity-60">⟡ Spawning sessions in worktrees...</div>
                <div className="text-[rgba(134,239,172,0.8)]">✓ Session s-001 spawned → issue #42</div>
                <div className="text-[rgba(134,239,172,0.8)]">✓ Session s-002 spawned → issue #43</div>
                <div className="text-[rgba(134,239,172,0.8)]">✓ Session s-003 spawned → issue #44</div>
                <div className="text-[rgba(134,239,172,0.8)]">✓ Session s-004 spawned → issue #45</div>
                <div className="text-[rgba(134,239,172,0.8)]">✓ Session s-005 spawned → issue #46</div>
                <div className="text-[var(--landing-muted)] opacity-60">&nbsp;</div>
                <div><span className="landing-agent-dot mr-1.5" /><span className="text-[var(--landing-muted)] opacity-60">5 agents working · Dashboard → http://localhost:3000</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* Step 2 */}
        <div className="landing-reveal grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div className="md:order-2">
            <div className="font-mono text-xs tracking-[0.1em] text-[var(--landing-muted)] opacity-50 mb-4">02</div>
            <h3 className="font-sans font-[680] tracking-tight text-lg tracking-tight mb-4">
              Agents <em className="italic text-[var(--landing-muted)]">work</em>
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.7] max-w-[28rem]">
              Each agent spawns in an isolated worktree. They write code, create PRs, run tests, and fix failures. Monitor everything from the live dashboard, or let them run.
            </p>
          </div>
          <div className="landing-card rounded-2xl p-8 min-h-[260px] md:order-1">
            <div className="rounded-2xl overflow-hidden bg-black/30">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-[var(--landing-card-bg)] border-b border-[var(--landing-border-subtle)]">
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
                <div className="w-2.5 h-2.5 rounded-full bg-[rgba(255,240,220,0.12)]" />
                <span className="text-[0.6875rem] text-[var(--landing-muted)] opacity-50 ml-2">my-saas-app · 5 sessions</span>
              </div>
              <div className="grid grid-cols-4 gap-2 p-3">
                <DashColumn title="Working" cards={[
                  { title: "Add user auth flow", meta: "#42 · feat/auth", agent: "claude-code" },
                  { title: "Fix pagination bug", meta: "#43 · fix/pagination", agent: "codex" },
                ]} />
                <DashColumn title="Pending" cards={[
                  { title: "Add rate limiting", meta: "#44 · PR #312", agent: "aider" },
                ]} />
                <DashColumn title="Review" cards={[
                  { title: "Update API tests", meta: "#45 · PR #310", agent: "claude-code", amber: true },
                ]} />
                <DashColumn title="Merged" cards={[
                  { title: "Refactor DB layer", meta: "#46 · PR #308", agent: "opencode", done: true },
                ]} />
              </div>
            </div>
          </div>
        </div>

        {/* Step 3 */}
        <div className="landing-reveal grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-xs tracking-[0.1em] text-[var(--landing-muted)] opacity-50 mb-4">03</div>
            <h3 className="font-sans font-[680] tracking-tight text-lg tracking-tight mb-4">
              PRs <em className="italic text-[var(--landing-muted)]">land</em>
            </h3>
            <p className="text-[var(--landing-muted)] text-[0.9375rem] leading-[1.7] max-w-[28rem]">
              Agents create pull requests, address review comments, fix CI failures, and get them to mergeable state. Your morning starts with merged PRs, not a backlog.
            </p>
          </div>
          <div className="landing-card rounded-2xl p-6 min-h-[260px]">
            <div className="flex flex-col gap-2.5">
              {[
                { branch: "feat/user-auth", title: "Add user authentication flow" },
                { branch: "fix/pagination-offset", title: "Fix off-by-one in cursor pagination" },
                { branch: "feat/rate-limiting", title: "Add Redis-backed rate limiter" },
                { branch: "refactor/db-layer", title: "Extract repository pattern from services" },
              ].map((pr) => (
                <div key={pr.branch} className="bg-[var(--landing-surface)] border border-[var(--landing-border-subtle)] rounded-xl px-5 py-4 flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <div className="font-mono text-xs text-[var(--landing-fg)]/70">{pr.branch}</div>
                    <div className="text-[0.8125rem] text-[var(--landing-muted)]">{pr.title}</div>
                  </div>
                  <div className="font-mono text-[0.625rem] tracking-[0.05em] px-3 py-1 rounded-full bg-[rgba(134,239,172,0.08)] text-[rgba(134,239,172,0.7)]">
                    ✓ Merged
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface DashCardData {
  title: string;
  meta: string;
  agent: string;
  amber?: boolean;
  done?: boolean;
}

function DashColumn({ title, cards }: { title: string; cards: DashCardData[] }) {
  return (
    <div>
      <div className="font-mono text-[0.625rem] tracking-[0.1em] uppercase text-[var(--landing-muted)] opacity-40 px-2 mb-1">
        {title}
      </div>
      {cards.map((card) => (
        <div key={card.meta} className="bg-[var(--landing-surface)] border border-[var(--landing-border-subtle)] rounded-lg p-2.5 mb-1.5 text-[0.6875rem]">
          <div className="text-[var(--landing-fg)]/70 mb-1">{card.title}</div>
          <div className="font-mono text-[0.5625rem] text-[var(--landing-muted)] opacity-50">{card.meta}</div>
          <div className="flex items-center gap-1 mt-1 font-mono text-[0.5625rem] text-[var(--landing-muted)] opacity-60">
            {card.done ? (
              <span>✓</span>
            ) : (
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: card.amber ? "rgba(251,191,36,0.7)" : "rgba(134,239,172,0.7)" }} />
            )}
            {card.agent}
          </div>
        </div>
      ))}
    </div>
  );
}
