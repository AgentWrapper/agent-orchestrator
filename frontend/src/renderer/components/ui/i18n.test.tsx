import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRendererI18n } from "../../i18n";
import { Breadcrumb } from "./breadcrumb";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";
import { SidebarProvider, SidebarTrigger } from "./sidebar";

afterEach(async () => {
	await initializeRendererI18n("en");
});

describe("localized UI primitives", () => {
	it("localizes breadcrumb and close controls", async () => {
		await initializeRendererI18n("zh-CN");

		const breadcrumb = render(<Breadcrumb />);
		expect(screen.getByRole("navigation", { name: "面包屑" })).toBeInTheDocument();
		breadcrumb.unmount();

		const dialog = render(
			<Dialog open>
				<DialogContent>
					<DialogTitle>Project One</DialogTitle>
					<DialogDescription>/repo/project-one</DialogDescription>
				</DialogContent>
			</Dialog>,
		);
		expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
		dialog.unmount();

		render(
			<Sheet open>
				<SheetContent>
					<SheetTitle>Project One</SheetTitle>
					<SheetDescription>/repo/project-one</SheetDescription>
				</SheetContent>
			</Sheet>,
		);
		expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
	});

	it("localizes the sidebar trigger accessible name", async () => {
		await initializeRendererI18n("zh-CN");
		render(
			<SidebarProvider>
				<SidebarTrigger />
			</SidebarProvider>,
		);

		expect(screen.getByRole("button", { name: "切换侧边栏" })).toBeInTheDocument();
	});
});
