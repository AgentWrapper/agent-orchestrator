import { readFileSync } from "fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config.js";

const require = createRequire(import.meta.url);
const { HTML_LIMITED_BOT_UA_RE_STRING } = require("next/dist/shared/lib/router/utils/is-bot") as {
  HTML_LIMITED_BOT_UA_RE_STRING: string;
};

describe("next config htmlLimitedBots", () => {
  const htmlLimitedBots = nextConfig.htmlLimitedBots as RegExp;

  it("preserves Next's crawler list without matching normal Chrome traffic", () => {
    expect(htmlLimitedBots.test("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(htmlLimitedBots.test("facebookexternalhit/1.1")).toBe(true);
    expect(htmlLimitedBots.test("Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe(
      false,
    );
  });

  it("keeps audit user agents HTML-limited", () => {
    expect(htmlLimitedBots.test("Chrome-Lighthouse")).toBe(true);
    expect(htmlLimitedBots.test("PageSpeed Insights")).toBe(true);
    expect(htmlLimitedBots.test("Mozilla/5.0 Lighthouse")).toBe(true);
  });

  it("does not depend on private Next internals at config evaluation time", () => {
    const source = readFileSync("next.config.js", "utf8");

    expect(source).not.toContain("next/dist/");
  });

  it("fails loudly when Next changes its default HTML-limited bot list", () => {
    expect(htmlLimitedBots.source).toContain(HTML_LIMITED_BOT_UA_RE_STRING);
  });
});
