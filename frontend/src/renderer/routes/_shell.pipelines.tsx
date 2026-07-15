import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/utils";

// The `project` search param is the single source of truth for which project's
// pipelines are shown; both the Definitions (T9) and Runs (T10) tabs read it, so
// switching the picker or deep-linking keeps them in sync via the URL.
type PipelinesSearch = { project?: string };

export const Route = createFileRoute("/_shell/pipelines")({
	validateSearch: (search: Record<string, unknown>): PipelinesSearch => ({
		project: typeof search.project === "string" ? search.project : undefined,
	}),
	component: PipelinesLayout,
});

// Runs lives on a sibling route owned by T10; until it merges this link 404s,
// which is fine; the whole section ships behind T11's flag. Cast keeps the typed
// Link happy while the target route is absent from the generated tree.
const RUNS_PATH = "/pipelines/runs" as "/pipelines";

function PipelinesLayout() {
	const navigate = useNavigate();
	const { project } = Route.useSearch();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const workspaces = useWorkspaceQuery().data ?? [];

	const selectedProject = project ?? workspaces[0]?.id;

	// Pin the effective project into the URL so children (and reloads) resolve the
	// same project the picker shows, instead of an implicit default.
	useEffect(() => {
		if (!project && selectedProject) {
			void navigate({ to: "/pipelines", search: { project: selectedProject }, replace: true });
		}
	}, [project, selectedProject, navigate]);

	const onRunsTab = pathname.startsWith("/pipelines/runs");

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<div className="flex items-center gap-3 px-4.5 pt-5.5">
				<h1 className="text-heading font-bold tracking-tight-xl text-foreground">Pipelines</h1>
				<div className="ml-auto">
					<Select
						value={selectedProject}
						onValueChange={(value) => void navigate({ to: "/pipelines", search: { project: value } })}
						disabled={workspaces.length === 0}
					>
						<SelectTrigger size="sm" aria-label="Project" className="min-w-40">
							<SelectValue placeholder="Select a project" />
						</SelectTrigger>
						<SelectContent>
							{workspaces.map((workspace) => (
								<SelectItem key={workspace.id} value={workspace.id}>
									{workspace.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="mt-3 flex items-center gap-1 border-b border-border px-4.5">
				<TabLink to="/pipelines" active={!onRunsTab} search={{ project: selectedProject }}>
					Definitions
				</TabLink>
				<TabLink to={RUNS_PATH} active={onRunsTab} search={{ project: selectedProject }}>
					Runs
				</TabLink>
			</div>

			<div className="min-h-0 flex-1">
				<Outlet />
			</div>
		</div>
	);
}

function TabLink({
	to,
	active,
	search,
	children,
}: {
	to: "/pipelines";
	active: boolean;
	search: PipelinesSearch;
	children: React.ReactNode;
}) {
	return (
		<Link
			to={to}
			search={search}
			className={cn(
				"-mb-px border-b-2 px-2.5 py-2 text-control font-medium transition-colors",
				active ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</Link>
	);
}
