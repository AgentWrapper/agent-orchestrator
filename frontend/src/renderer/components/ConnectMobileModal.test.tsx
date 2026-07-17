import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { i18n, initializeRendererI18n } from "../i18n";
import { ConnectMobileModal, pairingPayload } from "./ConnectMobileModal";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock("../lib/api-client", async (importOriginal) => ({
	...((await importOriginal()) as object),
	apiClient: { GET: getMock, POST: postMock },
}));

function renderModal() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<ConnectMobileModal open onOpenChange={vi.fn()} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getMock.mockReset();
	postMock.mockReset();
});

test("QR payload carries host, port, and password for one-scan connect", () => {
	const s = pairingPayload("192.168.1.42", 3011, "xKb1Z3A1");
	expect(JSON.parse(s)).toEqual({ v: 1, host: "192.168.1.42", port: 3011, password: "xKb1Z3A1" });
});

describe("ConnectMobileModal", () => {
	test("localizes application copy while preserving address, password, and payload values", async () => {
		await initializeRendererI18n("zh-CN");
		const password = "fake-mobile-secret";
		getMock.mockResolvedValue({
			data: {
				enabled: true,
				host: "192.168.2.220",
				port: 3011,
				password,
				warning: "Traffic on this connection is not encrypted. Only use it on a network you trust.",
			},
		});

		renderModal();

		expect(await screen.findByRole("dialog", { name: "连接移动端" })).toBeInTheDocument();
		expect(await screen.findByText("192.168.2.220:3011")).toBeInTheDocument();
		expect(screen.getByText(password)).toBeInTheDocument();
		expect(screen.getByText("此连接的流量未加密。请仅在你信任的网络中使用。")).toBeInTheDocument();
		expect(pairingPayload("192.168.2.220", 3011, password)).toBe(
			JSON.stringify({ v: 1, host: "192.168.2.220", port: 3011, password }),
		);
	});

	test("updates a stable action error when the language changes", async () => {
		getMock.mockResolvedValue({
			data: { enabled: false, host: "192.168.2.220", port: 3011, password: "", warning: "fixed warning" },
		});
		postMock.mockResolvedValue({
			error: { error: "mobile", code: "MOBILE_ENABLE", message: "raw internal detail" },
		});
		const user = userEvent.setup();
		renderModal();

		await user.click(await screen.findByRole("switch", { name: "Enable mobile" }));
		expect(await screen.findByText("Mobile access could not be enabled")).toBeInTheDocument();

		await act(async () => i18n.changeLanguage("zh-CN"));
		expect(screen.getByText("无法启用移动端访问")).toBeInTheDocument();
		expect(screen.queryByText("raw internal detail")).not.toBeInTheDocument();
	});
});
