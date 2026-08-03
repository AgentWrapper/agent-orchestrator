import { expect, it } from "vitest";

import { workOSRedirectResponse } from "./workos-redirect-response";

it("commits the PKCE cookie response before navigating to WorkOS", async () => {
  const authURL =
    "https://api.workos.com/user_management/authorize?state=sealed&screen_hint=sign-up";

  const response = workOSRedirectResponse(authURL);

  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const body = await response.text();
  expect(body).toContain(
    "https://api.workos.com/user_management/authorize?state=sealed&amp;screen_hint=sign-up",
  );
  expect(body).toContain('meta http-equiv="refresh"');
});

it("escapes an authorization URL before writing HTML", async () => {
  const response = workOSRedirectResponse(
    'https://api.workos.com/authorize?state="><script>alert(1)</script>',
  );

  const body = await response.text();
  expect(body).not.toContain("<script>alert(1)</script>");
  expect(body).toContain("&quot;&gt;&lt;script&gt;");
});
