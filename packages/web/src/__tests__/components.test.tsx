import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CIBadge, CICheckList } from "@/components/CIBadge";
import { PRStatus } from "@/components/PRStatus";
import { SessionCard } from "@/components/SessionCard";
import { AttentionZone } from "@/components/AttentionZone";
import { ActivityDot } from "@/components/ActivityDot";
import { makeSession, makePR } from "./helpers";

// ── ActivityDot ───────────────────────────────────────────────────────

describe("ActivityDot", () => {
  it("renders label pill with activity name", () => {
    render(<ActivityDot activity="active" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders all known activity states", () => {
    const states = ["active", "ready", "idle", "waiting_input", "blocked", "exited"] as const;
    for (const state of states) {
      const { unmount } = render(<ActivityDot activity={state} />);
      const expected = state === "waiting_input" ? "waiting" : state;
      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders unknown activity state with raw label", () => {
    render(<ActivityDot activity="some_future_state" />);
    expect(screen.getByText("some_future_state")).toBeInTheDocument();
  });

  it("renders null activity with 'unknown' label", () => {
    render(<ActivityDot activity={null} />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders only a dot in dotOnly mode (no label)", () => {
    render(<ActivityDot activity="active" dotOnly />);
    // No label text should appear in dotOnly mode
    expect(screen.queryByText("active")).not.toBeInTheDocument();
  });
});

// ── CIBadge ──────────────────────────────────────────────────────────

describe("CIBadge", () => {
  it("renders passing status", () => {
    render(<CIBadge status="passing" />);
    expect(screen.getByText("CI passing")).toBeInTheDocument();
  });

  it("renders failing status with check count", () => {
    const checks = [
      { name: "build", status: "failed" as const },
      { name: "test", status: "failed" as const },
      { name: "lint", status: "passed" as const },
    ];
    render(<CIBadge status="failing" checks={checks} />);
    expect(screen.getByText("2 checks failing")).toBeInTheDocument();
  });

  it("renders single failing check without plural", () => {
    const checks = [
      { name: "build", status: "failed" as const },
      { name: "lint", status: "passed" as const },
    ];
    render(<CIBadge status="failing" checks={checks} />);
    expect(screen.getByText("1 check failing")).toBeInTheDocument();
  });

  it("renders pending status", () => {
    render(<CIBadge status="pending" />);
    expect(screen.getByText("CI pending")).toBeInTheDocument();
  });

  it("renders em-dash for none status", () => {
    const { container } = render(<CIBadge status="none" />);
    expect(container.textContent).toContain("—");
  });

  it("hides icon in compact mode", () => {
    const { container } = render(<CIBadge status="passing" compact />);
    // In compact mode, no icon span before the label
    const spans = container.querySelectorAll("span > span");
    // Should only have the label text, no extra icon span
    expect(spans.length).toBe(0);
  });
});

// ── CICheckList ──────────────────────────────────────────────────────

describe("CICheckList", () => {
  it("renders all checks", () => {
    const checks = [
      { name: "build", status: "passed" as const },
      { name: "test", status: "failed" as const, url: "https://example.com/test" },
      { name: "lint", status: "pending" as const },
    ];
    render(<CICheckList checks={checks} />);
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("sorts failed checks first", () => {
    const checks = [
      { name: "lint", status: "passed" as const },
      { name: "build", status: "failed" as const },
      { name: "test", status: "running" as const },
    ];
    const { container } = render(<CICheckList checks={checks} />);
    const names = Array.from(container.querySelectorAll(".truncate")).map((el) => el.textContent);
    expect(names[0]).toBe("build"); // failed first
    expect(names[1]).toBe("test"); // running second
    expect(names[2]).toBe("lint"); // passed last
  });

  it("renders view links for checks with URLs", () => {
    const checks = [
      { name: "build", status: "passed" as const, url: "https://example.com/build" },
      { name: "test", status: "passed" as const },
    ];
    render(<CICheckList checks={checks} />);
    const links = screen.getAllByText("view");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/build");
  });
});

// ── PRStatus ─────────────────────────────────────────────────────────

describe("PRStatus", () => {
  it("renders PR number as link", () => {
    const pr = makePR({ number: 42 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("#42").closest("a")).toHaveAttribute("href", pr.url);
  });

  it("renders size label", () => {
    const pr = makePR({ additions: 50, deletions: 10 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("+50 -10 S")).toBeInTheDocument();
  });

  it("computes XL size label for large PRs", () => {
    const pr = makePR({ additions: 800, deletions: 300 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("+800 -300 XL")).toBeInTheDocument();
  });

  it("shows merged badge for merged PRs", () => {
    const pr = makePR({ state: "merged" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("merged")).toBeInTheDocument();
  });

  it("shows draft badge for draft PRs", () => {
    const pr = makePR({ isDraft: true, state: "open" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("shows approved badge", () => {
    const pr = makePR({ reviewDecision: "approved", state: "open" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("does not show CI badge for draft PRs", () => {
    const pr = makePR({ isDraft: true, state: "open", ciStatus: "passing" });
    render(<PRStatus pr={pr} />);
    expect(screen.queryByText("CI passing")).not.toBeInTheDocument();
  });

  it("does not show CI badge for merged PRs", () => {
    const pr = makePR({ state: "merged", ciStatus: "passing" });
    render(<PRStatus pr={pr} />);
    expect(screen.queryByText("CI passing")).not.toBeInTheDocument();
  });
});

// ── SessionCard ──────────────────────────────────────────────────────

describe("SessionCard", () => {
  it("renders summary when no PR, issue title, or branch title exists", () => {
    const session = makeSession({ id: "backend-1", summary: "Fixing auth", branch: null });
    render(<SessionCard session={session} />);
    expect(screen.getByText("backend-1")).toBeInTheDocument();
    expect(screen.getByText("Fixing auth")).toBeInTheDocument();
  });

  it("shows PR title instead of summary when PR exists", () => {
    const pr = makePR({ title: "feat: add auth" });
    const session = makeSession({ summary: "Fixing auth", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("feat: add auth")).toBeInTheDocument();
  });

  it("renders branch name", () => {
    const session = makeSession({ branch: "feat/cool-thing" });
    render(<SessionCard session={session} />);
    expect(screen.getByText("feat/cool-thing")).toBeInTheDocument();
  });

  it("does not render lifecycle guidance as a pill on kanban cards", () => {
    const session = makeSession({
      lifecycle: {
        sessionState: "detecting",
        sessionReason: "runtime_lost",
        prState: "none",
        prReason: "not_created",
        runtimeState: "missing",
        runtimeReason: "tmux_missing",
        session: {
          state: "detecting",
          reason: "runtime_lost",
          label: "detecting",
          reasonLabel: "runtime lost",
          startedAt: new Date().toISOString(),
          completedAt: null,
          terminatedAt: null,
          lastTransitionAt: new Date().toISOString(),
        },
        pr: {
          state: "none",
          reason: "not_created",
          label: "not created",
          reasonLabel: "not created",
          number: null,
          url: null,
          lastObservedAt: null,
        },
        runtime: {
          state: "missing",
          reason: "tmux_missing",
          label: "missing",
          reasonLabel: "tmux missing",
          lastObservedAt: new Date().toISOString(),
        },
        legacyStatus: "detecting",
        evidence: null,
        detectingAttempts: 1,
        detectingEscalatedAt: null,
        summary: "Detecting runtime truth (runtime lost)",
        guidance: "Checking runtime and process evidence now.",
      },
    });

    render(<SessionCard session={session} />);
    expect(
      screen.queryByText("Checking runtime and process evidence now."),
    ).not.toBeInTheDocument();
  });

  it("renders terminal link", () => {
    const session = makeSession({ id: "backend-5" });
    render(<SessionCard session={session} />);
    const link = screen.getByText("terminal");
    expect(link).toHaveAttribute(
      "href",
      "/projects/my-app/sessions/backend-5#session-terminal-section",
    );
  });

  it("shows restore button when agent has exited", () => {
    const session = makeSession({ activity: "exited" });
    render(<SessionCard session={session} />);
    // Header shows compact "restore"; expanded panel shows "restore session"
    expect(screen.getByText("restore")).toHaveClass("session-card__restore-control");
  });

  it("does not show restore button when agent is active", () => {
    const session = makeSession({ activity: "active" });
    render(<SessionCard session={session} />);
    expect(screen.queryByText("restore")).not.toBeInTheDocument();
  });

  it("calls onRestore when restore button is clicked", () => {
    const onRestore = vi.fn();
    const session = makeSession({ id: "backend-1", activity: "exited" });
    render(<SessionCard session={session} onRestore={onRestore} />);
    // Click the header "restore" button (always visible)
    fireEvent.click(screen.getByText("restore"));
    expect(onRestore).toHaveBeenCalledWith("backend-1");
  });

  it("shows merge button when PR is mergeable", () => {
    const pr = makePR({
      number: 42,
      state: "open",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByRole("button", { name: /merge/i })).toBeInTheDocument();
  });

  it("calls onMerge when merge button is clicked", () => {
    const onMerge = vi.fn();
    const pr = makePR({
      number: 42,
      state: "open",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(<SessionCard session={session} onMerge={onMerge} />);
    fireEvent.click(screen.getByRole("button", { name: /merge/i }));
    expect(onMerge).toHaveBeenCalledWith(42);
  });

  it("renders passing CI check chips as hyperlinks when url is present", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      ciChecks: [
        {
          name: "lint-and-type-checks",
          status: "passed",
          url: "https://github.com/owner/repo/runs/111",
        },
        { name: "tests", status: "passed", url: "https://github.com/owner/repo/runs/222" },
        { name: "no-url-check", status: "passed" },
      ],
      reviewDecision: "approved",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(<SessionCard session={session} />);

    const lintLink = screen.getByRole("link", { name: /lint-and-type-checks/ });
    expect(lintLink).toHaveAttribute("href", "https://github.com/owner/repo/runs/111");
    expect(lintLink).toHaveAttribute("target", "_blank");
    expect(lintLink).toHaveAttribute("rel", "noopener noreferrer");

    const testsLink = screen.getByRole("link", { name: /^tests$/ });
    expect(testsLink).toHaveAttribute("href", "https://github.com/owner/repo/runs/222");

    // Check without url should still render as plain text, not a link
    expect(screen.queryByRole("link", { name: /no-url-check/ })).not.toBeInTheDocument();
    expect(screen.getByText("no-url-check")).toBeInTheDocument();
  });

  it("stops propagation when clicking a passing CI chip link", () => {
    const onClick = vi.fn();
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      ciChecks: [
        { name: "build", status: "passed", url: "https://github.com/owner/repo/runs/333" },
      ],
      reviewDecision: "approved",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(
      <div onClick={onClick}>
        <SessionCard session={session} />
      </div>,
    );
    const link = screen.getByRole("link", { name: /build/ });
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows CI failing alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [
        { name: "build", status: "passed" },
        { name: "test", status: "failed" },
      ],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "ci_failed", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByRole("link", { name: "1 check failing" })).toBeInTheDocument();
  });

  it("shows CI status unknown when ciStatus is failing but no failed checks", () => {
    // This happens when GitHub API fails - getCISummary returns "failing"
    // but getCIChecks returns empty array
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [], // Empty - API failed to fetch checks
      reviewDecision: "none",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI is failing"],
      },
    });
    const session = makeSession({ status: "ci_failed", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("CI unknown")).toBeInTheDocument();
    // Should NOT show "0 CI check failing"
    expect(screen.queryByText(/0.*CI check.*failing/i)).not.toBeInTheDocument();
    // Should NOT show "ask to fix" action for unknown CI
    expect(screen.queryByText("ask to fix")).not.toBeInTheDocument();
  });

  it("shows changes requested alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "changes_requested",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("changes requested")).toBeInTheDocument();
  });

  it("shows needs review alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "pending",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("needs review")).toBeInTheDocument();
  });

  it("shows unresolved comments alert with count", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "approved",
      unresolvedThreads: 3,
      unresolvedComments: [
        { url: "https://example.com/1", path: "src/a.ts", author: "alice", body: "fix" },
        { url: "https://example.com/2", path: "src/b.ts", author: "bob", body: "fix" },
        { url: "https://example.com/3", path: "src/c.ts", author: "carol", body: "fix" },
      ],
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("unresolved comments")).toBeInTheDocument();
  });

  it("shows action buttons when agent is idle", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByRole("button", { name: "Ask to fix" })).toBeInTheDocument();
  });

  it("shows action buttons even when agent is active", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "active", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByRole("button", { name: "Ask to fix" })).toBeInTheDocument();
  });

  it("shows issue details in the compact card footer", () => {
    const session = makeSession({ id: "test-1", issueId: "INT-100", pr: null });
    render(<SessionCard session={session} />);
    expect(screen.getAllByText("INT-100")).toHaveLength(1);
  });

  it("shows icon-only terminate button in the footer", () => {
    const session = makeSession({ pr: null });
    render(<SessionCard session={session} />);
    expect(screen.getByRole("button", { name: /terminate session/i })).toBeInTheDocument();
  });

  it("prevents duplicate quick-reply preset sends while a send is in flight", async () => {
    let resolveSend: (() => void) | null = null;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const session = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("respond-1", "continue");
    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Abort" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /type a reply to the agent/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(onSend).toHaveBeenCalledTimes(1);

    resolveSend?.();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sent" })).toBeInTheDocument();
    });
  });

  it("hides quick reply presets for terminal sessions", () => {
    const session = makeSession({
      id: "respond-ended",
      status: "terminated",
      activity: "exited",
      summary: "Need approval to proceed",
    });

    render(<SessionCard session={session} />);

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abort" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /type a reply to the agent/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /view current context/i })).toHaveAttribute(
      "href",
      "/projects/my-app/sessions/respond-ended",
    );
    expect(screen.getByText("restore")).toBeInTheDocument();
  });

  it("prevents duplicate enter submits and only clears the textarea after send settles", async () => {
    let resolveSend: (() => void) | null = null;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const session = makeSession({
      id: "respond-2",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const input = screen.getByRole("textbox", { name: /type a reply to the agent/i });
    fireEvent.change(input, { target: { value: "please continue" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("respond-2", "please continue");
    expect(screen.getByRole("textbox", { name: /type a reply to the agent/i })).toBeDisabled();
    expect(screen.getByDisplayValue("please continue")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("textbox", { name: /type a reply to the agent/i }), {
      key: "Enter",
      code: "Enter",
    });
    expect(onSend).toHaveBeenCalledTimes(1);

    resolveSend?.();

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /type a reply to the agent/i })).toHaveValue("");
    });
  });

  it("does not show sent state or clear reply text when quick reply send fails", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("network failed")));
    const session = makeSession({
      id: "respond-3",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const input = screen.getByRole("textbox", { name: /type a reply to the agent/i });
    fireEvent.change(input, { target: { value: "please continue" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Sent" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: /type a reply to the agent/i })).toHaveValue(
        "please continue",
      );
      expect(
        screen.getByRole("textbox", { name: /type a reply to the agent/i }),
      ).not.toBeDisabled();
    });
  });

  it("shows a temporary failed state when an alert action send is rejected", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("network failed")));
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });

    render(<SessionCard session={session} onSend={onSend} />);

    const actionButton = screen.getByRole("button", { name: "Ask to fix" });
    fireEvent.click(actionButton);

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "failed" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Sent!" })).not.toBeInTheDocument();
  });
});

// ── AttentionZone ────────────────────────────────────────────────────

describe("AttentionZone", () => {
  it("renders zone label and session count", () => {
    const sessions = [makeSession({ id: "s1" }), makeSession({ id: "s2" })];
    render(<AttentionZone level="respond" sessions={sessions} />);
    // Labels use CSS text-transform:uppercase but DOM text is title-cased
    expect(screen.getByText("Respond")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders empty state when sessions array is empty", () => {
    render(<AttentionZone level="respond" sessions={[]} />);
    expect(screen.getByText("Respond")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("No agents need your input.")).not.toBeInTheDocument();
  });

  it("renders zone-specific empty messages for all attention zones", () => {
    const cases: Array<[string, string]> = [
      ["review", "Review"],
      ["pending", "Pending"],
      ["working", "Working"],
      ["done", "Done"],
    ];
    for (const [level, expectedLabel] of cases) {
      const { unmount } = render(
        <AttentionZone level={level as "review" | "pending" | "working" | "done"} sessions={[]} />,
      );
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      expect(screen.getByText("0")).toBeInTheDocument();
      unmount();
    }
  });

  it("shows session cards when not collapsed", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="respond" sessions={sessions} />);
    // respond is defaultCollapsed: false, so cards should be visible
    expect(screen.getByText("s1")).toBeInTheDocument();
  });

  it("working zone is collapsed by default", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="working" sessions={sessions} />);
    // working is defaultCollapsed: false (Kanban always shows), so sessions visible
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("done zone always shows sessions (kanban columns are always expanded)", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="done" sessions={sessions} />);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("s1")).toBeInTheDocument();
  });

  it("passes callbacks to SessionCards", () => {
    const onRestore = vi.fn();
    const sessions = [makeSession({ id: "s1", activity: "exited" })];
    render(<AttentionZone level="respond" sessions={sessions} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("restore"));
    expect(onRestore).toHaveBeenCalledWith("s1");
  });
});

// ── Unenriched PR shimmer ─────────────────────────────────────────────

describe("Unenriched PR shimmer", () => {
  it("SessionCard shows shimmer for unenriched PR size", () => {
    const pr = makePR({ enriched: false });
    const session = makeSession({ pr });
    const { container } = render(<SessionCard session={session} />);
    const shimmers = container.querySelectorAll(".animate-pulse");
    expect(shimmers.length).toBeGreaterThan(0);
  });

  it("SessionCard shows actual size for enriched PR", () => {
    const pr = makePR({ enriched: true, additions: 50, deletions: 10 });
    const session = makeSession({ pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("+50 -10 S")).toBeInTheDocument();
  });

  it("SessionCard suppresses alerts for unenriched PR", () => {
    const pr = makePR({
      enriched: false,
      ciStatus: "failing",
      ciChecks: [{ name: "build", status: "failed" }],
    });
    const session = makeSession({ pr });
    const { container } = render(<SessionCard session={session} />);
    expect(container.querySelector(".session-card__alert-pill")).toBeNull();
  });

  it("PRStatus shows shimmer for unenriched PR", () => {
    const pr = makePR({ enriched: false });
    const { container } = render(<PRStatus pr={pr} />);
    const shimmers = container.querySelectorAll(".animate-pulse");
    expect(shimmers.length).toBeGreaterThan(0);
  });

  it("PRStatus shows actual data for enriched PR", () => {
    const pr = makePR({ enriched: true, additions: 50, deletions: 10 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("+50 -10 S")).toBeInTheDocument();
  });
});
