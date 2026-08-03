import { afterEach, expect, it, vi } from "vitest";

import { restoreWorkOSSession } from "./workos-cloud";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("restores a WorkOS session from the local bridge endpoint", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: "workos-jwt",
          authProvider: "workos",
          user: {
            id: "user_123",
            email: "person@example.com",
            displayName: "Person",
          },
        }),
        { status: 200 },
      ),
    ),
  );

  const session = await restoreWorkOSSession();

  expect(fetch).toHaveBeenCalledWith(
    "/api/cloud-auth/session",
    expect.objectContaining({ credentials: "include" }),
  );
  expect(session).toEqual({
    accessToken: "workos-jwt",
    authProvider: "workos",
    user: {
      id: "user_123",
      email: "person@example.com",
      displayName: "Person",
    },
  });
});

it("returns null when there is no WorkOS session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    ),
  );

  await expect(restoreWorkOSSession()).resolves.toBeNull();
});
