import { describe, expect, it } from "vitest";
import {
	buildCommands,
	filterCommands,
	groupCommands,
	displayGroups,
	MAX_ITEMS_PER_GROUP,
	MAX_SEARCH_RESULTS,
	type CommandItem,
} from "./command-palette";
import type { PullRequestFacts, WorkspaceSession, WorkspaceSummary } from "../types/workspace";

function session(overrides: Partial<WorkspaceSession> & { id: string }): WorkspaceSession {
	return {
		workspaceId: "proj-1",
		workspaceName: "app",
		title: overrides.id,
		provider: "codex",
		kind: "worker",
		branch: `feature/${overrides.id}`,
		status: "working",
		updatedAt: "2026-06-10T00:00:00Z",
		prs: [],
		...overrides,
	};
}

const pr = (number: number, url = `https://github.com/o/r/pull/${number}`): PullRequestFacts => ({
	url,
	number,
	state: "open",
	ci: "passing",
	review: "pending",
	mergeability: "clean",
	reviewComments: false,
	updatedAt: "2026-06-10T00:00:00Z",
});

function workspaces(): WorkspaceSummary[] {
	return [
		{
			id: "proj-1",
			name: "app",
			path: "/repos/app",
			type: "main",
			sessions: [
				session({ id: "w-working", title: "refactor loader", status: "working" }),
				session({ id: "w-merge", title: "ship banner", status: "mergeable" }),
				session({ id: "w-action", title: "fix flake", status: "needs_input" }),
				session({ id: "w-pr", title: "add cache", status: "pr_open", prs: [pr(42)] }),
				session({ id: "w-synthetic", title: "scratch", branch: "session/w-synthetic" }),
				session({ id: "orch", title: "orchestrate", kind: "orchestrator" }),
			],
		},
	];
}

const byId = (items: CommandItem[]) => new Map(items.map((item) => [item.id, item]));

describe("buildCommands grouping", () => {
	it("puts current-scoped actions in the Current group when the project is valid", () => {
		const items = buildCommands({ workspaces: workspaces(), currentProjectId: "proj-1", currentSessionId: "w-pr" });
		const map = byId(items);
		expect(map.get("current-new-task")?.group).toBe("current");
		expect(map.get("current-open-orchestrator")?.group).toBe("current");
		expect(map.get("current-project-settings")?.group).toBe("current");
		expect(map.get("current-copy-branch")?.group).toBe("current");
		expect(map.get("current-copy-branch")?.action).toEqual({ kind: "copy-branch", branch: "feature/w-pr" });
	});

	it("disables New task with a reason when the route project is absent from workspaces", () => {
		const items = buildCommands({ workspaces: workspaces(), currentProjectId: "missing", currentSessionId: undefined });
		const newTask = byId(items).get("current-new-task");
		expect(newTask?.disabled).toBe(true);
		expect(newTask?.disabledReason).toBe("No current project");
		expect(newTask?.action).toBeUndefined();
		expect(byId(items).has("current-open-orchestrator")).toBe(false);
		expect(byId(items).has("current-project-settings")).toBe(false);
	});

	it("disables New task and Open orchestrator while the project orchestrator is restarting", () => {
		const items = buildCommands({
			workspaces: workspaces(),
			currentProjectId: "proj-1",
			restartingProjectIds: new Set(["proj-1"]),
		});
		const map = byId(items);
		expect(map.get("current-new-task")?.disabled).toBe(true);
		expect(map.get("current-new-task")?.disabledReason).toBe("Orchestrator restarting");
		expect(map.get("current-open-orchestrator")?.disabled).toBe(true);
		expect(map.get("current-open-orchestrator")?.disabledReason).toBe("Orchestrator restarting");
		expect(map.get("current-project-settings")?.disabled).toBeFalsy();
	});

	it("omits Copy branch for a synthetic (session/<id>) branch and for orchestrators", () => {
		const synthetic = buildCommands({ workspaces: workspaces(), currentSessionId: "w-synthetic" });
		expect(byId(synthetic).has("current-copy-branch")).toBe(false);
		const orch = buildCommands({ workspaces: workspaces(), currentSessionId: "orch" });
		expect(byId(orch).has("current-copy-branch")).toBe(false);
	});
});

describe("buildCommands attention", () => {
	it("includes ready-to-merge AND attention-needing sessions, ordered merge-first", () => {
		const items = buildCommands({ workspaces: workspaces() });
		const attention = items.filter((item) => item.group === "attention");
		const ids = attention.map((item) => item.id);
		expect(ids).toContain("attention:w-merge");
		expect(ids).toContain("attention:w-action");
		expect(ids).not.toContain("attention:w-working");
		expect(ids.indexOf("attention:w-merge")).toBeLessThan(ids.indexOf("attention:w-action"));
	});

	it("omits the current session from Needs attention (already in view)", () => {
		const items = buildCommands({ workspaces: workspaces(), currentSessionId: "w-merge" });
		const ids = new Set(items.map((item) => item.id));
		expect(ids.has("attention:w-merge")).toBe(false);
		expect(ids.has("attention:w-action")).toBe(true);
	});
});

describe("buildCommands sessions", () => {
	it("does not repeat attention or current sessions in the flat Sessions list", () => {
		const items = buildCommands({ workspaces: workspaces(), currentSessionId: "w-working" });
		const ids = new Set(items.map((item) => item.id));
		expect(ids.has("attention:w-merge")).toBe(true);
		expect(ids.has("session:w-merge")).toBe(false);
		expect(ids.has("attention:w-action")).toBe(true);
		expect(ids.has("session:w-action")).toBe(false);
		expect(ids.has("session:w-working")).toBe(false);
		expect(ids.has("session:w-synthetic")).toBe(true);
	});
});

describe("buildCommands pull requests", () => {
	it("creates a per-PR item searchable by number, #number, url, branch and project", () => {
		const items = buildCommands({ workspaces: workspaces() });
		const prItem = byId(items).get("pr:w-pr:42");
		expect(prItem?.group).toBe("prs");
		expect(prItem?.title).toBe("#42");
		const keywords = prItem?.keywords ?? [];
		expect(keywords).toContain("#42");
		expect(keywords).toContain("42");
		expect(keywords).toContain("https://github.com/o/r/pull/42");
		expect(keywords).toContain("feature/w-pr");
		expect(keywords).toContain("app");
	});

	it("excludes merged and closed PRs (open/draft only)", () => {
		const merged: PullRequestFacts = { ...pr(7), state: "merged" };
		const closed: PullRequestFacts = { ...pr(8), state: "closed" };
		const ws: WorkspaceSummary[] = [
			{
				id: "proj-1",
				name: "app",
				path: "/repos/app",
				type: "main",
				sessions: [session({ id: "w-mix", title: "mixed prs", prs: [merged, closed, pr(9)] })],
			},
		];
		const ids = new Set(buildCommands({ workspaces: ws }).map((item) => item.id));
		expect(ids.has("pr:w-mix:9")).toBe(true);
		expect(ids.has("pr:w-mix:7")).toBe(false);
		expect(ids.has("pr:w-mix:8")).toBe(false);
	});
});

describe("buildCommands finished sessions", () => {
	function withFinished(): WorkspaceSummary[] {
		return [
			{
				id: "proj-1",
				name: "app",
				path: "/repos/app",
				type: "main",
				sessions: [
					session({ id: "w-live", title: "live one", status: "working" }),
					session({ id: "w-done", title: "archived cleanup", status: "terminated" }),
					session({ id: "w-merged", title: "old merge", status: "merged" }),
				],
			},
		];
	}

	it("indexes merged/terminated sessions as search-only (hidden until typed, then findable)", () => {
		const items = buildCommands({ workspaces: withFinished() });
		const done = byId(items).get("session:w-done");
		expect(done?.searchOnly).toBe(true);
		expect(byId(items).get("session:w-live")?.searchOnly).toBeFalsy();

		const suggested = filterCommands(items, "");
		expect(suggested.some((item) => item.id === "session:w-done")).toBe(false);
		expect(suggested.some((item) => item.id === "session:w-live")).toBe(true);

		const searched = filterCommands(items, "archived");
		expect(searched.some((item) => item.id === "session:w-done")).toBe(true);
	});
});

describe("result caps", () => {
	const manyProjects = (n: number): WorkspaceSummary[] =>
		Array.from({ length: n }, (_, i) => ({
			id: `p${i}`,
			name: `project-${i}`,
			path: `/repos/p${i}`,
			type: "main" as const,
			sessions: [],
		}));

	it("caps the pre-typing suggestion view per group so huge installs never render every row", () => {
		const grouped = displayGroups(buildCommands({ workspaces: manyProjects(50) }), "");
		expect(grouped.find((g) => g.id === "projects")?.items.length).toBe(MAX_ITEMS_PER_GROUP);
		expect(grouped.find((g) => g.id === "global")?.items.length).toBeGreaterThan(0);
	});

	it("renders a typed search as one flat Results group capped to MAX_SEARCH_RESULTS", () => {
		const groups = displayGroups(buildCommands({ workspaces: manyProjects(50) }), "project");
		expect(groups).toHaveLength(1);
		expect(groups[0]?.id).toBe("results");
		expect(groups[0]?.items.length).toBe(MAX_SEARCH_RESULTS);
	});

	it("preserves global rank order across categories (higher score renders first, not by group)", () => {
		const workspaces: WorkspaceSummary[] = [
			{
				id: "alpha",
				name: "alpha",
				path: "/repos/alpha",
				type: "main",
				sessions: [session({ id: "s-attn", title: "fix alpha bug", status: "needs_input" })],
			},
		];
		const groups = displayGroups(buildCommands({ workspaces }), "alpha");
		expect(groups).toHaveLength(1);
		const order = groups[0]?.items.map((item) => item.id) ?? [];
		expect(order[0]).toBe("project:alpha");
		expect(order).toContain("attention:s-attn");
		expect(order.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
	});
});

describe("filterCommands / matchScore", () => {
	it("ranks a title prefix above a keyword-only hit", () => {
		const items = buildCommands({ workspaces: workspaces() });
		const results = filterCommands(items, "app");
		expect(results[0]?.id).toBe("project:proj-1");
	});

	it("matches a PR by its #number", () => {
		const items = buildCommands({ workspaces: workspaces() });
		const results = filterCommands(items, "#42");
		expect(results.some((item) => item.id === "pr:w-pr:42")).toBe(true);
	});
});

describe("groupCommands", () => {
	it("skips empty groups and preserves group order", () => {
		const items = buildCommands({ workspaces: workspaces(), currentProjectId: "proj-1" });
		const grouped = groupCommands(items);
		const order = grouped.map((g) => g.id);
		expect(order).toEqual(["current", "attention", "projects", "sessions", "prs", "global"]);
		expect(grouped.every((g) => g.items.length > 0)).toBe(true);
	});
});
