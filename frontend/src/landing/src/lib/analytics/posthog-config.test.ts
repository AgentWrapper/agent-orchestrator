import { describe, expect, it } from "vitest";
import {
  buildMarketingPostHogConfig,
  DEFAULT_MARKETING_POSTHOG_HOST,
  resolveMarketingPostHogHost,
} from "./posthog-config";

describe("marketing PostHog host", () => {
  // "/ingest" needed a Next rewrite that a static export cannot provide, so the
  // host must always be absolute. A relative value here means every capture
  // request 404s against GitHub Pages, silently.
  it("resolves to an absolute host, never a relative path", () => {
    expect(resolveMarketingPostHogHost(undefined)).toBe(DEFAULT_MARKETING_POSTHOG_HOST);
    expect(resolveMarketingPostHogHost("")).toBe(DEFAULT_MARKETING_POSTHOG_HOST);
    expect(resolveMarketingPostHogHost("   ")).toBe(DEFAULT_MARKETING_POSTHOG_HOST);
    expect(resolveMarketingPostHogHost(DEFAULT_MARKETING_POSTHOG_HOST)).not.toMatch(/^\//);
  });

  it("honours a configured host so a reverse proxy can be swapped in", () => {
    expect(resolveMarketingPostHogHost(" https://ph.aoagents.dev ")).toBe(
      "https://ph.aoagents.dev",
    );
  });
});

describe("marketing PostHog config", () => {
  // Production always supplies a real bootstrap (getHeroFlagBootstrap returns
// NonNullable), so the test mirrors that rather than widening the signature.
const config = buildMarketingPostHogConfig(DEFAULT_MARKETING_POSTHOG_HOST, {
  distinctID: "test-distinct-id",
  isIdentifiedID: false,
  featureFlags: {},
});

  // AO records no sessions on any surface, by product decision. This is the
  // guard against replay being switched on by an edit that looks unrelated.
  it("never enables session replay", () => {
    expect(config.disable_session_recording).toBe(true);
  });

  // Autocapture is not recording: it captures clicks and element text, not a
  // replay of the screen. It stays on for public marketing copy.
  it("keeps autocapture on for the marketing site", () => {
    expect(config.autocapture).toBe(true);
  });

  // Kept dormant so a future narrow opt-in starts from masked inputs rather
  // than whatever the defaults happen to be that week.
  it("keeps input masking configured even while recording is off", () => {
    expect(config.session_recording?.maskAllInputs).toBe(true);
    expect(config.session_recording?.blockSelector).toBe("[data-ph-no-record]");
  });

  it("keeps pageview, pageleave, and exception capture on for retention and errors", () => {
    expect(config.capture_pageview).toBe("history_change");
    expect(config.capture_pageleave).toBe(true);
    expect(config.capture_exceptions).toBe(true);
  });

  // Capturing before the visitor accepts would be a consent violation, and the
  // default must stay opt-out even as other settings change around it.
  it("stays opt-out until consent is granted, and creates no person profiles", () => {
    expect(config.opt_out_capturing_by_default).toBe(true);
    expect(config.person_profiles).toBe("never");
  });

  it("never points ingestion at a relative path", () => {
    expect(config.api_host).toBe(DEFAULT_MARKETING_POSTHOG_HOST);
    expect(config.api_host).not.toBe("/ingest");
  });
});
