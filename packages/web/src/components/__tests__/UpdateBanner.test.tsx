import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UpdateBanner } from "../UpdateBanner";

const DISMISS_KEY = "ao.updateBanner.dismissedFor";

function mockVersionResponse(body: {
  current: string;
  latest: string | null;
  channel: "stable" | "nightly" | "manual";
  isOutdated: boolean;
  checkedAt?: string | null;
}) {
  return {
    ok: true,
    json: async () => ({ checkedAt: null, ...body }),
  } as Response;
}

describe("UpdateBanner", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders nothing when /api/version reports up-to-date", async () => {
    fetchMock.mockResolvedValueOnce(
      mockVersionResponse({
        current: "0.5.0",
        latest: "0.5.0",
        channel: "stable",
        isOutdated: false,
      }),
    );
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("renders banner when isOutdated is true", async () => {
    fetchMock.mockResolvedValueOnce(
      mockVersionResponse({
        current: "0.5.0",
        latest: "0.5.1",
        channel: "stable",
        isOutdated: true,
      }),
    );
    render(<UpdateBanner />);
    await screen.findByText(/Update available: 0.5.0 → 0.5.1/);
  });

  it("hides on manual channel even when outdated (user opted out)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockVersionResponse({
        current: "0.5.0",
        latest: "0.5.1",
        channel: "manual",
        isOutdated: true,
      }),
    );
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("hides when dismissed via localStorage for the current latest version", async () => {
    window.localStorage.setItem(DISMISS_KEY, "0.5.1");
    fetchMock.mockResolvedValueOnce(
      mockVersionResponse({
        current: "0.5.0",
        latest: "0.5.1",
        channel: "stable",
        isOutdated: true,
      }),
    );
    const { container } = render(<UpdateBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("re-shows the banner when a NEW version is available after dismissal", async () => {
    // User dismissed 0.5.1; now 0.5.2 is out — banner reappears.
    window.localStorage.setItem(DISMISS_KEY, "0.5.1");
    fetchMock.mockResolvedValueOnce(
      mockVersionResponse({
        current: "0.5.0",
        latest: "0.5.2",
        channel: "stable",
        isOutdated: true,
      }),
    );
    render(<UpdateBanner />);
    await screen.findByText(/Update available: 0.5.0 → 0.5.2/);
  });

  it("POSTs to /api/update on click and hides on success", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockVersionResponse({
          current: "0.5.0",
          latest: "0.5.1",
          channel: "stable",
          isOutdated: true,
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ ok: true, message: "started" }),
      } as Response);

    const { container } = render(<UpdateBanner />);
    const button = await screen.findByRole("button", { name: "Update" });
    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/update", { method: "POST" }),
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("surfaces 409 active-session refusal as inline error text", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockVersionResponse({
          current: "0.5.0",
          latest: "0.5.1",
          channel: "stable",
          isOutdated: true,
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          message: "3 sessions active. Run `ao stop` first.",
          activeSessions: 3,
        }),
      } as Response);

    render(<UpdateBanner />);
    const button = await screen.findByRole("button", { name: "Update" });
    fireEvent.click(button);

    await screen.findByText(/3 sessions active/);
  });

  it("dismiss button hides the banner even from the 'blocked' (409) error state", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockVersionResponse({
          current: "0.5.0",
          latest: "0.5.1",
          channel: "stable",
          isOutdated: true,
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          message: "1 session active. Run `ao stop` first.",
          activeSessions: 1,
        }),
      } as Response);

    const { container } = render(<UpdateBanner />);
    const update = await screen.findByRole("button", { name: "Update" });
    fireEvent.click(update);
    // Wait for the 409 to surface so we're definitely in the blocked phase.
    await screen.findByText(/1 session active/);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
