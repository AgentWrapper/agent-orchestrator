import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ConnectMobileSetup } from "./ConnectMobileSetup";

test("LAN steps show by default", () => {
	render(<ConnectMobileSetup port={3011} enabled={true} />);
	expect(screen.getByText(/same Wi-Fi as this computer/i)).toBeInTheDocument();
	expect(screen.queryByText(/tailscale ip -4/i)).not.toBeInTheDocument();
});

test("Tailscale tab explains manual entry and echoes the live port", async () => {
	render(<ConnectMobileSetup port={3011} enabled={true} />);
	await userEvent.click(screen.getByRole("tab", { name: "Tailscale" }));
	expect(screen.getByText(/tailscale ip -4/i)).toBeInTheDocument();
	expect(
		screen.getByText((_, el) => el?.textContent?.includes("port 3011") ?? false, { selector: "li" }),
	).toBeInTheDocument();
});

test("tabs leave the tab order while the bridge is disabled", () => {
	render(<ConnectMobileSetup port={3011} enabled={false} />);
	expect(screen.getByRole("tab", { name: "LAN" })).toHaveAttribute("tabindex", "-1");
});
