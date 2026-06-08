import { describe, expect, it } from "vitest";
import { getReviewBoardColumn, type DashboardReviewRun } from "../review-types";

function makeRun(status: DashboardReviewRun["status"]): Pick<DashboardReviewRun, "status"> {
  return { status };
}

describe("getReviewBoardColumn", () => {
  it("maps reviewer run statuses into review board columns", () => {
    expect(getReviewBoardColumn(makeRun("queued"))).toBe("queued");
    expect(getReviewBoardColumn(makeRun("preparing"))).toBe("queued");
    expect(getReviewBoardColumn(makeRun("running"))).toBe("reviewing");
    expect(getReviewBoardColumn(makeRun("needs_triage"))).toBe("triage");
    expect(getReviewBoardColumn(makeRun("sent_to_agent"))).toBe("waiting");
    expect(getReviewBoardColumn(makeRun("waiting_update"))).toBe("waiting");
    expect(getReviewBoardColumn(makeRun("clean"))).toBe("clean");
    expect(getReviewBoardColumn(makeRun("failed"))).toBe("failed");
    expect(getReviewBoardColumn(makeRun("cancelled"))).toBe("failed");
    expect(getReviewBoardColumn(makeRun("outdated"))).toBe("outdated");
  });
});
