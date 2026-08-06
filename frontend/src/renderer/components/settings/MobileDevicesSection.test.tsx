import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { apiClient } from "../../lib/api-client";
import { MobileDevicesSection } from "./MobileDevicesSection";

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MobileDevicesSection />
		</QueryClientProvider>,
	);
}

const twoDevices = {
	data: {
		devices: [
			{
				installId: "i1", token: "ExponentPushToken[a]", deviceName: "iPhone", platform: "ios",
				muted: false, live: true, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
			},
			{
				installId: "i2", token: "ExponentPushToken[b]", deviceName: "M31s", platform: "android",
				muted: true, live: false, createdAt: new Date().toISOString(),
				lastSeenAt: new Date(Date.now() - 7200_000).toISOString(),
			},
		],
	},
};

describe("MobileDevicesSection", () => {
	it("shows a live device and a last-seen fallback", async () => {
		vi.spyOn(apiClient, "GET").mockResolvedValue(twoDevices as never);
		renderSection();

		expect(await screen.findByText("iPhone")).toBeInTheDocument();
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.getByText("M31s")).toBeInTheDocument();
		expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
	});

	it("mutes a device", async () => {
		vi.spyOn(apiClient, "GET").mockResolvedValue(twoDevices as never);
		const patch = vi.spyOn(apiClient, "PATCH").mockResolvedValue({ data: { muted: true } } as never);
		renderSection();

		const toggle = await screen.findByRole("switch", { name: /notifications for iPhone/i });
		fireEvent.click(toggle);

		await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
		expect(patch.mock.calls[0][1]).toMatchObject({
			params: { path: { installId: "i1" } },
			body: { muted: true },
		});
	});

	it("removes a device only after confirmation", async () => {
		vi.spyOn(apiClient, "GET").mockResolvedValue(twoDevices as never);
		const del = vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined } as never);
		renderSection();

		fireEvent.click(await screen.findByRole("button", { name: /remove iPhone/i }));
		expect(del).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /confirm remove/i }));
		await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
	});

	it("shows an empty state when nothing is paired", async () => {
		vi.spyOn(apiClient, "GET").mockResolvedValue({ data: { devices: [] } } as never);
		renderSection();
		expect(await screen.findByText(/No devices paired yet/i)).toBeInTheDocument();
	});

	it("shows a distinct message when the device registry is unavailable, not the empty state", async () => {
		vi.spyOn(apiClient, "GET").mockResolvedValue({
			data: undefined,
			error: {
				error: "device registry unavailable",
				code: "DEVICE_REGISTRY_UNAVAILABLE",
				message: "device registry unavailable",
				requestId: "req-1",
			},
		} as never);
		renderSection();

		expect(await screen.findByText(/Device registry unavailable/i)).toBeInTheDocument();
		expect(screen.getByText(/AO could not read your saved devices/i)).toBeInTheDocument();
		expect(screen.queryByText(/No devices paired yet/i)).not.toBeInTheDocument();
	});
});
