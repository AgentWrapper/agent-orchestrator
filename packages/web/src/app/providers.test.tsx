import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock MuxProvider to avoid WebSocket setup
vi.mock("@/providers/MuxProvider", () => ({
  MuxProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="mux">{children}</div>,
}));

// Mock next-themes
vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="theme">{children}</div>,
}));

import { Providers } from "./providers";

describe("Providers", () => {
  it("renders children inside theme and mux providers", () => {
    render(
      <Providers>
        <span data-testid="child">Hello</span>
      </Providers>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("Hello");
    expect(screen.getByTestId("theme")).toBeInTheDocument();
    expect(screen.getByTestId("mux")).toBeInTheDocument();
  });
});
