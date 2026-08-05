import { describe, expect, it } from "vitest";
import {
  DESKTOP_PROJECT_KEY,
  REPLAY_PATH,
  replayDecision,
} from "./design-partner-replay";

const OWN_PROJECT = "phc_marketingProjectKeyThatIsNotTheApp";

describe("design partner replay", () => {
  it("records on the design partner page once the site has its own project", () => {
    expect(
      replayDecision({ key: OWN_PROJECT, pathname: REPLAY_PATH, optedOut: false }),
    ).toEqual({ record: true });
  });

  // The whole reason this function exists. Both surfaces point at one project
  // today, and arming replay there would record the screens of desktop installs
  // already in the field, including builds too old to carry the client block.
  it("refuses while the key is the desktop project, on the right page and with consent", () => {
    expect(
      replayDecision({ key: DESKTOP_PROJECT_KEY, pathname: REPLAY_PATH, optedOut: false }),
    ).toEqual({ record: false, reason: "shared-project" });
  });

  it("refuses whitespace-padded variants of the desktop key", () => {
    expect(
      replayDecision({ key: `  ${DESKTOP_PROJECT_KEY}  `, pathname: REPLAY_PATH, optedOut: false }),
    ).toEqual({ record: false, reason: "shared-project" });
  });

  it("records nowhere else on the site", () => {
    for (const path of ["/", "/download", "/docs/overview", "/design-partner", "/design-partners-old"]) {
      expect(
        replayDecision({ key: OWN_PROJECT, pathname: path, optedOut: false }),
      ).toEqual({ record: false, reason: "wrong-path" });
    }
  });

  it("treats a trailing slash and a sub-path as the same page", () => {
    for (const path of [`${REPLAY_PATH}/`, `${REPLAY_PATH}/apply`]) {
      expect(replayDecision({ key: OWN_PROJECT, pathname: path, optedOut: false })).toEqual({
        record: true,
      });
    }
  });

  // Recording somebody who declined analytics is worse than not recording.
  it("refuses when the visitor has not consented", () => {
    expect(
      replayDecision({ key: OWN_PROJECT, pathname: REPLAY_PATH, optedOut: true }),
    ).toEqual({ record: false, reason: "not-consented" });
  });

  it("refuses when no key is configured at all", () => {
    for (const key of [undefined, "", "   "]) {
      expect(replayDecision({ key, pathname: REPLAY_PATH, optedOut: false })).toEqual({
        record: false,
        reason: "no-key",
      });
    }
  });
});
