import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-name", () => ({
  getProjectName: () => "Agent Orchestrator",
}));

describe("app manifest", () => {
  it("builds the PWA manifest with project-aware naming and icons", async () => {
    const { default: manifest } = await import("./manifest");

    expect(manifest()).toMatchObject({
      name: "ao | Agent Orchestrator",
      short_name: "ao",
      start_url: "/",
      display: "standalone",
      background_color: "#121110",
      theme_color: "#121110",
      icons: [
        { src: "/apple-icon", sizes: "180x180", type: "image/png" },
        { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    });
  });
});
