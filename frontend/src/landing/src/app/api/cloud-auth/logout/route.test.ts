import { afterEach, expect, it, vi } from "vitest";

import { workOSLogoutReturnTo } from "./route";

vi.mock("@workos-inc/authkit-nextjs", () => ({
  signOut: vi.fn(),
}));

afterEach(() => {
  delete process.env.NEXT_PUBLIC_WEB_URL;
});

it("uses the hosted web origin for WorkOS logout returns", () => {
  process.env.NEXT_PUBLIC_WEB_URL = "https://ao.example.com";

  expect(workOSLogoutReturnTo()).toBe("https://ao.example.com/auth");
});

it("keeps local logout relative when no hosted origin is configured", () => {
  expect(workOSLogoutReturnTo()).toBe("/auth");
});
