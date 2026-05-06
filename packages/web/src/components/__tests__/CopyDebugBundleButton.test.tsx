import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ToastProvider } from "../Toast";
import { CopyDebugBundleButton } from "../CopyDebugBundleButton";

const writeText = vi.fn(() => Promise.resolve());
const fetchMock = vi.fn();

function renderButton(projectId?: string) {
  return render(
    <ToastProvider>
      <CopyDebugBundleButton projectId={projectId} />
    </ToastProvider>,
  );
}

describe("CopyDebugBundleButton", () => {
  beforeEach(() => {
    writeText.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => (name === "x-correlation-id" ? "corr-test" : null) },
      json: () =>
        Promise.resolve({
          overallStatus: "ok",
          projects: {
            "my-app": { status: "warn", trace: { reason: "Bearer sk-1234567890 token failed" } },
            "other-app": { status: "ok" },
          },
        }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    window.history.replaceState({}, "", "/?token=secret#frag");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies observability JSON and shows success toast", async () => {
    renderButton("my-app");

    fireEvent.click(screen.getByRole("button", { name: /Copy debug bundle for issue reports/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });

    const written = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(written.projectId).toBe("my-app");
    expect(written.correlationId).toBe("corr-test");
    expect(written.pageHref).toMatch(/^http:\/\/localhost(?::\d+)?\/$/);
    expect(written.observability.projects).toEqual({
      "my-app": { status: "warn", trace: { reason: "[REDACTED] token failed" } },
    });

    await waitFor(() => {
      expect(screen.getByText(/Debug bundle copied to clipboard/i)).toBeInTheDocument();
    });
  });

  it("shows error toast and skips clipboard when observability request fails", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: { get: () => null },
    } as Response);

    renderButton("my-app");
    fireEvent.click(screen.getByRole("button", { name: /Copy debug bundle for issue reports/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not fetch observability snapshot/i)).toBeInTheDocument();
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("shows error toast when clipboard write fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard blocked"));

    renderButton("my-app");
    fireEvent.click(screen.getByRole("button", { name: /Copy debug bundle for issue reports/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not copy debug bundle/i)).toBeInTheDocument();
    });
  });
});
