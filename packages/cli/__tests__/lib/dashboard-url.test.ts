import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dashboardUrl } from "../../src/lib/dashboard-url.js";

describe("dashboardUrl", () => {
  const original = process.env.AO_PUBLIC_URL;

  beforeEach(() => {
    delete process.env.AO_PUBLIC_URL;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AO_PUBLIC_URL;
    } else {
      process.env.AO_PUBLIC_URL = original;
    }
  });

  it("falls back to localhost when AO_PUBLIC_URL is unset", () => {
    expect(dashboardUrl(3000)).toBe("http://localhost:3000");
  });

  it("falls back to localhost when AO_PUBLIC_URL is empty", () => {
    process.env.AO_PUBLIC_URL = "";
    expect(dashboardUrl(8094)).toBe("http://localhost:8094");
  });

  it("falls back to localhost when AO_PUBLIC_URL is whitespace only", () => {
    process.env.AO_PUBLIC_URL = "   ";
    expect(dashboardUrl(8094)).toBe("http://localhost:8094");
  });

  it("uses AO_PUBLIC_URL when set", () => {
    process.env.AO_PUBLIC_URL = "https://ao.example.com";
    expect(dashboardUrl(3000)).toBe("https://ao.example.com");
  });

  it("ignores the port argument when AO_PUBLIC_URL is set", () => {
    process.env.AO_PUBLIC_URL = "https://ao.example.com";
    expect(dashboardUrl(3000)).toBe("https://ao.example.com");
    expect(dashboardUrl(8094)).toBe("https://ao.example.com");
  });

  it("strips a trailing slash from AO_PUBLIC_URL", () => {
    process.env.AO_PUBLIC_URL = "https://ao.example.com/";
    expect(dashboardUrl(3000)).toBe("https://ao.example.com");
  });

  it("strips multiple trailing slashes from AO_PUBLIC_URL", () => {
    process.env.AO_PUBLIC_URL = "https://ao.example.com///";
    expect(dashboardUrl(3000)).toBe("https://ao.example.com");
  });

  it("preserves a sub-path in AO_PUBLIC_URL", () => {
    process.env.AO_PUBLIC_URL = "https://example.com/ao";
    expect(dashboardUrl(3000)).toBe("https://example.com/ao");
  });

  it("trims surrounding whitespace from AO_PUBLIC_URL", () => {
    process.env.AO_PUBLIC_URL = "  https://ao.example.com  ";
    expect(dashboardUrl(3000)).toBe("https://ao.example.com");
  });

  it("supports a non-default port in AO_PUBLIC_URL", () => {
    process.env.AO_PUBLIC_URL = "http://192.168.1.5:9000";
    expect(dashboardUrl(3000)).toBe("http://192.168.1.5:9000");
  });
});
