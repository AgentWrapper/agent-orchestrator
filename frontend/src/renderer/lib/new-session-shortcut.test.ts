import { describe, expect, it, vi } from "vitest";
import { dispatchNewSession, resolveScopedProjectId } from "./new-session-shortcut";
import type { WorkspaceSummary } from "../types/workspace";

const workspaces = [
	{ id: "proj-1", name: "One", path: "/one", sessions: [{ id: "s-1" }, { id: "s-2" }] },
	{ id: "proj-2", name: "Two", path: "/two", sessions: [{ id: "s-3" }] },
] as unknown as WorkspaceSummary[];

describe("resolveScopedProjectId", () => {
	it("prefers the route project id", () => {
		expect(resolveScopedProjectId({ projectId: "proj-2" }, workspaces)).toBe("proj-2");
	});

	it("resolves the owning workspace from a session id", () => {
		expect(resolveScopedProjectId({ sessionId: "s-3" }, workspaces)).toBe("proj-2");
	});

	it("is undefined with no project and no matching session", () => {
		expect(resolveScopedProjectId({}, workspaces)).toBeUndefined();
		expect(resolveScopedProjectId({ sessionId: "missing" }, workspaces)).toBeUndefined();
	});
});

describe("dispatchNewSession", () => {
	it("opens the New Task flow for the in-scope project", () => {
		const requestNewTask = vi.fn();
		const requestCreateProject = vi.fn();
		dispatchNewSession("proj-1", { requestNewTask, requestCreateProject });
		expect(requestNewTask).toHaveBeenCalledWith("proj-1");
		expect(requestCreateProject).not.toHaveBeenCalled();
	});

	it("falls back to create-project when no project is in scope", () => {
		const requestNewTask = vi.fn();
		const requestCreateProject = vi.fn();
		dispatchNewSession(undefined, { requestNewTask, requestCreateProject });
		expect(requestCreateProject).toHaveBeenCalledTimes(1);
		expect(requestNewTask).not.toHaveBeenCalled();
	});
});
