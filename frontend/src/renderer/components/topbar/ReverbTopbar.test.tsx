import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Folder, GitBranch } from "lucide-react";
import { motionValue } from "motion/react";
import { describe, expect, it, vi } from "vitest";
import { ReverbTopbar } from "./ReverbTopbar";
import type { ReverbTopbarModel } from "./topbar-model";

const projectBoardModel: ReverbTopbarModel = {
	surface: "project-board",
	breadcrumbs: [
		{ id: "project", label: "acme-app" },
		{ id: "board", label: "Board" },
	],
};

describe("ReverbTopbar", () => {
	it("renders a labelled header and breadcrumb navigation for its surface", () => {
		const { container } = render(<ReverbTopbar model={projectBoardModel} />);

		const header = container.querySelector("header");
		expect(header).toHaveAttribute("aria-label", "Reverb workspace");
		expect(header).toHaveAttribute("data-surface", "project-board");

		const breadcrumbs = screen.getByRole("navigation", { name: "Workspace breadcrumb" });
		const projectBreadcrumb = within(breadcrumbs).getByText("acme-app").closest(".reverb-topbar__breadcrumb");
		expect(projectBreadcrumb).toHaveClass("reverb-topbar__breadcrumb");
		expect(projectBreadcrumb).not.toHaveClass("text-sm");
		expect(projectBreadcrumb).not.toHaveAttribute("aria-current");
		expect(within(breadcrumbs).getByText("Board").closest(".reverb-topbar__breadcrumb")).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(container.querySelectorAll(".reverb-topbar__separator")).toHaveLength(1);
		expect(container.querySelector(".reverb-topbar__separator")).toHaveAttribute("aria-hidden", "true");
	});

	it("uses the explicitly current breadcrumb instead of defaulting to the last item", () => {
		render(
			<ReverbTopbar
				model={{
					...projectBoardModel,
					breadcrumbs: [
						{ id: "project", label: "acme-app", current: true },
						{ id: "branch", label: "feature/topbar" },
					],
				}}
			/>,
		);

		expect(screen.getByText("acme-app").closest(".reverb-topbar__breadcrumb")).toHaveAttribute("aria-current", "page");
		expect(screen.getByText("feature/topbar").closest(".reverb-topbar__breadcrumb")).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("renders a wired non-current breadcrumb as a semantic button", () => {
		const openProject = vi.fn();

		render(
			<ReverbTopbar
				dragStyle={{ WebkitAppRegion: "drag" } as React.CSSProperties}
				model={{
					...projectBoardModel,
					breadcrumbs: [
						{ id: "project", label: "acme-app", onClick: openProject },
						{ id: "board", label: "Board" },
					],
				}}
			/>,
		);

		const projectCrumb = screen.getByRole("button", { name: "acme-app" });
		expect(projectCrumb).toHaveClass("reverb-topbar__breadcrumb", "reverb-topbar__breadcrumb--interactive");
		expect((projectCrumb.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe("no-drag");

		fireEvent.click(projectCrumb);
		expect(openProject).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
	});

	it("renders leading and breadcrumb icons as decorative presentation slots", () => {
		const { container } = render(
			<ReverbTopbar
				leadingIcon={<Folder data-testid="leading-icon" />}
				model={{
					surface: "worker-session",
					breadcrumbs: [
						{ id: "project", label: "acme-app" },
						{ id: "branch", label: "feature/topbar", icon: <GitBranch data-testid="branch-icon" /> },
					],
				}}
			/>,
		);

		expect(screen.getByTestId("leading-icon").closest(".reverb-topbar__leading-icon")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(screen.getByTestId("branch-icon").closest(".reverb-topbar__breadcrumb-icon")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(container.querySelector(".reverb-topbar__breadcrumb-label")).toHaveClass("truncate");
	});

	it("keeps contextual state, route actions, errors, and utilities in distinct labelled zones", () => {
		const { container } = render(
			<ReverbTopbar
				actions={<button type="button">New task</button>}
				context={<span>Running</span>}
				error={<span role="alert">Could not start</span>}
				model={{
					...projectBoardModel,
					contextAriaLabel: "Session activity",
					actionsAriaLabel: "Board actions",
					utilitiesAriaLabel: "Workspace utilities",
				}}
				utilities={<button type="button">Notifications</button>}
			/>,
		);

		expect(screen.getByRole("group", { name: "Session activity" })).toHaveClass("reverb-topbar__state");
		expect(screen.getByRole("group", { name: "Board actions" })).toContainElement(
			screen.getByRole("button", { name: "New task" }),
		);
		expect(screen.getByRole("alert")).toHaveTextContent("Could not start");
		expect(screen.getByRole("group", { name: "Workspace utilities" })).toContainElement(
			screen.getByRole("button", { name: "Notifications" }),
		);
		expect(container.querySelector(".reverb-topbar__utility-separator")).toHaveAttribute("aria-hidden", "true");
	});

	it("omits empty controls and utility separation while retaining the layout state cell", () => {
		const { container } = render(<ReverbTopbar model={projectBoardModel} />);

		expect(screen.queryByRole("group", { name: "Page actions" })).not.toBeInTheDocument();
		expect(screen.queryByRole("group", { name: "Global utilities" })).not.toBeInTheDocument();
		expect(container.querySelector(".reverb-topbar__utility-separator")).not.toBeInTheDocument();
		expect(container.querySelector(".reverb-topbar__state--empty")).toHaveAttribute("aria-hidden", "true");
	});

	it("accepts host layout classes and a platform drag style without making controls part of the drag region", () => {
		const { container } = render(
			<ReverbTopbar
				actions={<button type="button">Action</button>}
				className="host-layout"
				dragStyle={{ WebkitAppRegion: "drag" } as React.CSSProperties}
				model={projectBoardModel}
				utilities={<button type="button">Utility</button>}
			/>,
		);

		const header = container.querySelector("header");
		expect(header).toHaveClass("reverb-topbar", "host-layout");
		expect((header?.style as (CSSStyleDeclaration & { WebkitAppRegion?: string }) | undefined)?.WebkitAppRegion).toBe(
			"drag",
		);
		expect(
			(
				screen.getByRole("group", { name: "Page actions" }).style as CSSStyleDeclaration & {
					WebkitAppRegion?: string;
				}
			).WebkitAppRegion,
		).toBe("no-drag");
		expect(
			(
				screen.getByRole("group", { name: "Global utilities" }).style as CSSStyleDeclaration & {
					WebkitAppRegion?: string;
				}
			).WebkitAppRegion,
		).toBe("no-drag");
	});

	it("applies live macOS titlebar clearance without changing the three-zone structure", async () => {
		const paddingLeft = motionValue(170);
		const { container } = render(<ReverbTopbar model={projectBoardModel} paddingLeft={paddingLeft} />);
		const header = container.querySelector("header");

		expect(header).toHaveStyle({ paddingLeft: "170px" });
		expect(header?.children).toHaveLength(3);

		act(() => paddingLeft.set(10));
		await waitFor(() => expect(header).toHaveStyle({ paddingLeft: "10px" }));
	});
});
