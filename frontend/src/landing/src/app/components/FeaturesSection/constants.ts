export interface Feature {
  tag: string;
  title: string;
  description: string;
  colors: readonly [string, string, string, string];
}

export const FEATURES: Feature[] = [
  {
    tag: "Delegation",
    title: "Tell the orchestrator what you need",
    description:
      "Every project gets a main agent that runs the fleet for you. Describe the outcome, it plans the work, spawns workers into their own worktrees, keeps them moving, and escalates only what needs a human.",
    colors: ["#7f1d1d", "#991b1b", "#450a0a", "#1a1a2e"],
  },
  {
    tag: "Visibility",
    title: "The whole fleet, at a glance",
    description:
      "Every session flows across one board, working, needs you, in review, ready to merge, with its agent, branch, and PR state on the card. You see what needs attention and ignore the rest.",
    colors: ["#047857", "#065f46", "#064e3b", "#1a1a2e"],
  },
  {
    tag: "Feedback Loop",
    title: "CI fails. The right agent hears about it.",
    description:
      "AO watches every PR it opens. Failed checks and review comments route back to the session that owns the branch, with the context to fix them, until the PR is approved.",
    colors: ["#1e40af", "#1e3a8a", "#172554", "#1a1a2e"],
  },
  {
    tag: "Coverage",
    title: "Use the agent you already trust",
    description:
      "23 harnesses supported, with per-project agent choice. Claude Code, Codex, Cursor, OpenCode, Aider, Goose, and more, AO keeps the workflow the same while the tools underneath evolve.",
    colors: ["#7c3aed", "#6d28d9", "#4c1d95", "#1a1a2e"],
  },
];
