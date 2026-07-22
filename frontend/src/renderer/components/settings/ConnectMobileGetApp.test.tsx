import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ConnectMobileGetApp, TESTFLIGHT_URL } from "./ConnectMobileGetApp";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock("../../lib/bridge", () => ({
	aoBridge: { app: { openExternal } },
}));

beforeEach(() => {
	openExternal.mockReset();
	openExternal.mockResolvedValue(undefined);
});

test("TestFlight button opens the join link through the app bridge", async () => {
	render(<ConnectMobileGetApp />);
	await userEvent.click(screen.getByRole("button", { name: "Join the TestFlight beta" }));
	expect(openExternal).toHaveBeenCalledWith("https://testflight.apple.com/join/t4U3fu2H");
	expect(TESTFLIGHT_URL).toBe("https://testflight.apple.com/join/t4U3fu2H");
});

test("Android is listed as not yet available", () => {
	render(<ConnectMobileGetApp />);
	expect(screen.getByText("Android")).toBeInTheDocument();
	expect(screen.getByText("Coming soon")).toBeInTheDocument();
});

// The join link is useless without Apple's TestFlight app, and "TestFlight beta"
// alone reads like a build channel rather than a prerequisite — say so plainly.
test("iOS row names TestFlight as a prerequisite install", () => {
	render(<ConnectMobileGetApp />);
	expect(screen.getByText(/Install Apple's TestFlight app first/i)).toBeInTheDocument();
});

test("QR code stays collapsed until the disclosure is toggled", async () => {
	render(<ConnectMobileGetApp />);
	const toggle = screen.getByRole("button", { name: "Show TestFlight QR code" });
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	expect(screen.getByTestId("testflight-qr")).toHaveAttribute("aria-hidden", "true");

	await userEvent.click(toggle);

	expect(screen.getByRole("button", { name: "Hide TestFlight QR code" })).toHaveAttribute("aria-expanded", "true");
	expect(screen.getByTestId("testflight-qr")).toHaveAttribute("aria-hidden", "false");
});
