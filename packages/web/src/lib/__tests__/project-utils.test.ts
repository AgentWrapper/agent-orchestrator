import { describe, expect, it } from "vitest";
import { filterProjectSessions } from "../project-utils";

describe("filterProjectSessions", () => {
  const projects = {
    app: { sessionPrefix: "app" },
    appx: { sessionPrefix: "appx" },
  };

  it("does not match another project's longer prefix as the selected project", () => {
    // Regression: prefix containment leaked appx sessions into app views.
    // Found by /qa on 2026-05-01.
    const sessions = [
      { id: "app-1", projectId: "unknown" },
      { id: "appx-1", projectId: "unknown" },
    ];

    expect(filterProjectSessions(sessions, "app", projects)).toEqual([
      { id: "app-1", projectId: "unknown" },
    ]);
  });
});
