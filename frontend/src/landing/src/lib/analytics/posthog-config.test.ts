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
  const config = buildMarketingPostHogConfig(DEFAULT_MARKETING_POSTHOG_HOST, undefined);

  // These two are the opposite of the desktop app on purpose. The app disables
  // both because its DOM holds source code, prompts, and terminal output; this
  // site is public copy, so heatmaps and replay are the point.
  it("enables autocapture and session replay for the marketing site", () => {
    expect(config.autocapture).toBe(true);
    expect(config.disable_session_recording).toBe(false);
  });

  it("masks visitor input in replays", () => {
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
