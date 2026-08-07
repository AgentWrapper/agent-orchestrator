import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSignInUrl: vi.fn(),
}));

vi.mock("@workos-inc/authkit-nextjs", () => ({
  getSignInUrl: mocks.getSignInUrl,
}));

import { GET } from "./route";

beforeEach(() => {
  mocks.getSignInUrl.mockReset();
  mocks.getSignInUrl.mockResolvedValue("https://workos.example/authorize");
});

it("keeps the share token in the sealed WorkOS return path", async () => {
  await GET(
    new Request(
      "https://ao.example/auth/workos/sign-in?returnTo=%2Fapp%3Fshare%3Dshare-token",
    ),
  );

  expect(mocks.getSignInUrl).toHaveBeenCalledWith({
    returnTo: "/app?share=share-token",
  });
});

it("rejects external WorkOS return paths", async () => {
  await GET(
    new Request(
      "https://ao.example/auth/workos/sign-in?returnTo=https%3A%2F%2Fattacker.example%2Fapp",
    ),
  );

  expect(mocks.getSignInUrl).toHaveBeenCalledWith({ returnTo: "/app" });
});
