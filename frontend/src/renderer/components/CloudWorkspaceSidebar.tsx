import { Cloud, Plus } from "lucide-react";
import {
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "./ui/sidebar";

export type CloudWorkspaceSummary = {
	id: string;
	repository: string;
};

export function CloudWorkspaceSidebar({
	workspaces = [],
	onNewWorkspace,
}: {
	workspaces?: CloudWorkspaceSummary[];
	onNewWorkspace: () => void;
}) {
	return (
		<SidebarContent className="gap-0 pl-2.5 pr-1.75 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-1.5">
			<SidebarGroup className="p-0">
				<div className="sidebar-expanded-chrome flex items-center justify-between px-2 pb-2 group-data-[collapsible=icon]:hidden">
					<SidebarGroupLabel className="h-auto rounded-none p-0 text-2xs font-semibold uppercase tracking-wide-lg text-passive">
						Cloud workspaces
					</SidebarGroupLabel>
					<button
						aria-label="New cloud workspace"
						className="grid size-icon-xl place-items-center rounded-sm text-passive transition-colors hover:bg-interactive-hover hover:text-foreground"
						onClick={onNewWorkspace}
						type="button"
					>
						<Plus aria-hidden="true" className="size-icon-sm" />
					</button>
				</div>

				<SidebarGroupContent>
					{workspaces.length === 0 ? (
						<div className="sidebar-expanded-chrome px-2 py-3 group-data-[collapsible=icon]:hidden">
							<p className="text-xs text-foreground">No cloud workspaces yet.</p>
							<p className="mt-1 text-caption text-passive">Create one from a GitHub repository.</p>
						</div>
					) : (
						<SidebarMenu className="gap-1">
							{workspaces.map((workspace) => (
								<SidebarMenuItem key={workspace.id}>
									<SidebarMenuButton tooltip={workspace.repository}>
										<Cloud aria-hidden="true" />
										<span>{workspace.repository}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					)}
					<div className="hidden group-data-[collapsible=icon]:block">
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton tooltip="New cloud workspace" onClick={onNewWorkspace}>
									<Plus aria-hidden="true" />
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</div>
				</SidebarGroupContent>
			</SidebarGroup>
		</SidebarContent>
	);
}
