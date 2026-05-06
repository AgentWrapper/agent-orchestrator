import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-name", () => ({
  getProjectName: () => "Agent Orchestrator",
}));

describe("app layout metadata", () => {
  it("exports the themed mobile viewport colors", async () => {
    const { viewport } = await import("./layout");

    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#f5f3f0" },
      { media: "(prefers-color-scheme: dark)", color: "#121110" },
    ]);
  });

  it("builds metadata with the project-aware title and apple web app settings", async () => {
    const { generateMetadata } = await import("./layout");

    await expect(generateMetadata()).resolves.toMatchObject({
      title: {
        template: "%s | Agent Orchestrator",
        default: "ao | Agent Orchestrator",
      },
      appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "ao | Agent Orchestrator",
      },
    });
  });
});
