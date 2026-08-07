import { expect, it } from "vitest";

import { cloudAppReturnTo } from "./auth-return-to";

it("preserves a share token on the cloud app return path", () => {
  expect(cloudAppReturnTo("/app?share=share-token")).toBe(
    "/app?share=share-token",
  );
});

it("rejects return paths outside the cloud app", () => {
  expect(cloudAppReturnTo("https://attacker.example/app?share=stolen")).toBe(
    "/app",
  );
  expect(cloudAppReturnTo("//attacker.example/app")).toBe("/app");
  expect(cloudAppReturnTo("/auth?returnTo=/app")).toBe("/app");
});
