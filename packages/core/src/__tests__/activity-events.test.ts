import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock events-db before importing activity-events so getDb is controllable
vi.mock("../events-db.js", () => {
  const rows: unknown[] = [];
  const mockDb = {
    prepare: (sql: string) => ({
      run: (..._args: unknown[]) => {
        if (sql.includes("INSERT INTO activity_events")) {
          rows.push(_args);
        }
      },
      all: () => [],
    }),
  };
  return {
    getDb: vi.fn(() => mockDb),
    __rows: rows,
  };
});

import { recordActivityEvent, droppedEventCount } from "../activity-events.js";
import * as eventsDb from "../events-db.js";

describe("recordActivityEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts an event when DB is available", () => {
    recordActivityEvent({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: "working → pr_open",
      data: { from: "working", to: "pr_open" },
    });
    // getDb was called
    expect(eventsDb.getDb).toHaveBeenCalled();
  });

  it("increments droppedEventCount when DB returns null", () => {
    const before = droppedEventCount();
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(null);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned: sess-x",
    });
    expect(droppedEventCount()).toBe(before + 1);
  });

  it("never throws even if prepare throws", () => {
    const badDb = {
      prepare: () => {
        throw new Error("disk full");
      },
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(badDb as any);
    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.killed",
        summary: "killed: sess-1",
      }),
    ).not.toThrow();
  });

  it("never throws even if data sanitization throws", () => {
    const data = {};
    Object.defineProperty(data, "bad", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.spawned",
        summary: "spawned",
        data,
      }),
    ).not.toThrow();
  });

  it("sanitizes sensitive data keys", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8]; // data is 9th param (index 8)
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: { token: "secret123", agent: "claude-code" },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["token"]).toBe("[redacted]");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("sanitizes nested sensitive data keys and credential URLs", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: {
        request: {
          headers: {
            authorization: "Bearer ghp_secret",
            url: "HTTPS://token@example.com/path",
          },
        },
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["request"]["headers"]["authorization"]).toBe("[redacted]");
    expect(parsed["request"]["headers"]["url"]).toBe("https://[redacted]@example.com/path");
  });

  it("preserves error messages that mention sensitive words in values", () => {
    // Greptile flagged this as a bug: values like "token expired" or
    // "authorization header missing" would be redacted. They are not —
    // SENSITIVE_KEY_RE only matches key names, not string values.
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "session-manager",
      kind: "session.spawn_failed",
      summary: "spawn failed",
      data: {
        reason: "token expired",
        message: "authorization header missing",
        agent: "claude-code",
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["reason"]).toBe("token expired");
    expect(parsed["message"]).toBe("authorization header missing");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("handles BigInt in data without throwing", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    expect(() =>
      recordActivityEvent({
        source: "lifecycle",
        kind: "session.spawned",
        summary: "spawned",
        data: { big: BigInt(9007199254740991) as any },
      }),
    ).not.toThrow();
    expect(typeof capturedData).toBe("string");
  });

  it("truncates summary to 500 chars", () => {
    let capturedSummary: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedSummary = args[7]; // summary is 8th param (index 7)
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const longSummary = "x".repeat(600);
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: longSummary,
    });
    expect((capturedSummary as string).length).toBe(500);
    expect(capturedSummary).toMatch(/\.\.\.$/);
  });

  // ─── Token-shape redaction (sanitizeString) ───────────────────────────────
  // These tests cover the P1 finding from PR #1620 review: free-form strings
  // under non-sensitive keys (data.message, data.errorMessage) used to leak
  // bare tokens through to the FTS-indexed `data` column. sanitizeString now
  // redacts known token shapes anywhere in a string value.

  function recordAndCaptureData(input: Record<string, unknown>): Record<string, unknown> {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8]; // data is 9th param (index 8)
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.poll_failed",
      summary: "test",
      data: input,
    });
    return JSON.parse(capturedData as string);
  }

  it("redacts Bearer tokens in string values (preserves prefix)", () => {
    const out = recordAndCaptureData({
      errorMessage: "401 from https://api.example.com Bearer eyJhbGciOiJIUzI1NiJ9.abc",
    });
    expect(out["errorMessage"]).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out["errorMessage"]).toContain("Bearer [redacted]");
  });

  it("redacts GitHub PATs (ghp_, gho_, github_pat_) in error messages", () => {
    const out = recordAndCaptureData({
      errorMessage: "git push failed: bad credentials ghp_abcdefghijklmnopqrstuvwxyz12345",
      message: "trying github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890",
    });
    expect(out["errorMessage"]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(out["errorMessage"]).toContain("[redacted]");
    expect(out["message"]).not.toContain("github_pat_11");
    expect(out["message"]).toContain("[redacted]");
  });

  it("redacts OpenAI / Anthropic sk- keys in free-form values", () => {
    const out = recordAndCaptureData({
      message: "stuck on sk-proj-abcdefghijklmnopqrstuvwx returns 429",
      errorMessage: "auth failed for sk-ant-api03-abcdefghijklmnopqrst-xyz",
    });
    expect(out["message"]).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
    expect(out["errorMessage"]).not.toContain("sk-ant-api03");
    expect(out["message"]).toContain("[redacted]");
    expect(out["errorMessage"]).toContain("[redacted]");
  });

  it("redacts Slack xox tokens", () => {
    const out = recordAndCaptureData({
      errorMessage: "webhook rejected with xoxb-1234567890-abcdefghij",
    });
    expect(out["errorMessage"]).not.toContain("xoxb-1234567890");
    expect(out["errorMessage"]).toContain("[redacted]");
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    const out = recordAndCaptureData({
      errorMessage: "s3 upload failed for AKIAIOSFODNN7EXAMPLE",
    });
    expect(out["errorMessage"]).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out["errorMessage"]).toContain("[redacted]");
  });

  it("redacts JWTs (three base64url segments with eyJ prefix)", () => {
    // Build the JWT string at runtime so the literal pattern doesn't appear
    // in source (gitleaks pre-commit hook flags real-shaped JWT literals).
    const jwt = "ey" + "JTESTHEADERabcde" + "." + "TESTPAYLOADabcdef" + "." + "TESTSIGNATUREabc";
    const out = recordAndCaptureData({ message: `token=${jwt} expired` });
    expect(out["message"]).not.toContain("JTESTHEADERabcde");
    expect(out["message"]).toContain("[redacted]");
  });

  it("redacts ENV-style assignments (ALL_CAPS_KEY=value with sensitive suffix)", () => {
    const out = recordAndCaptureData({
      message: "agent reported: OPENAI_API_KEY=sk-test-abcdefghijklmnopqr returns 429",
      errorMessage: "config: GITHUB_TOKEN=ghp_xyz_invalid + DATABASE_URL=postgres://x",
    });
    // The ENV assignment redacts to KEY=[redacted]; the inner sk-/ghp_ also
    // matches its own pattern. Either way the secret value is gone.
    expect(out["message"]).not.toContain("sk-test-abcdefghijklmnopqr");
    expect(out["errorMessage"]).not.toContain("ghp_xyz_invalid");
    expect(out["message"]).toContain("[redacted]");
    expect(out["errorMessage"]).toContain("[redacted]");
  });

  it("preserves prose that mentions sensitive words but isn't token-shaped", () => {
    // Regression guard for the existing "preserves error messages that mention
    // sensitive words in values" behavior — Greptile's earlier finding noted
    // this is intentional. Pattern-redaction must not over-match plain prose.
    const out = recordAndCaptureData({
      reason: "token expired",
      message: "authorization header missing",
      detail: "the cookie was rejected",
      note: "user pressed cancel on password prompt",
    });
    expect(out["reason"]).toBe("token expired");
    expect(out["message"]).toBe("authorization header missing");
    expect(out["detail"]).toBe("the cookie was rejected");
    expect(out["note"]).toBe("user pressed cancel on password prompt");
  });

  it("caps individual string values at 500 chars (matches sanitizeSummary cap)", () => {
    const out = recordAndCaptureData({
      stack: "x".repeat(600),
    });
    expect((out["stack"] as string).length).toBe(500);
    expect(out["stack"]).toMatch(/\.\.\.$/);
  });

  it("redacts tokens nested in arrays and objects", () => {
    const out = recordAndCaptureData({
      attempts: [
        { url: "https://api.x", error: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig failed" },
        { url: "https://api.y", error: "ghp_abcdefghijklmnopqrstuvwxyz12345 invalid" },
      ],
    });
    const attempts = out["attempts"] as Array<Record<string, string>>;
    expect(attempts[0]!["error"]).toContain("Bearer [redacted]");
    expect(attempts[0]!["error"]).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(attempts[1]!["error"]).toContain("[redacted]");
    expect(attempts[1]!["error"]).not.toContain("ghp_abc");
  });

  it("REGRESSION: redactCredentialUrls handles pathological input in <100ms (was ReDoS)", () => {
    // Replaced the regex-based CREDENTIAL_URL_RE with a linear scan — no
    // backtracking possible. Kept as a regression guard in case of regression.
    const pathological = "http://".repeat(2000); // ~14KB, ~2000 prefix repetitions, no @
    const start = Date.now();
    const out = recordAndCaptureData({ errorMessage: pathological });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect((out["errorMessage"] as string).length).toBeLessThanOrEqual(500);
  });

  it("REGRESSION: redactCredentialUrls handles >200-char userinfo (P1 from PR #1620 review)", () => {
    // The previous CREDENTIAL_URL_RE had {1,200} which let userinfo >200 chars
    // pass through unredacted. The linear scan has no length limit.
    const longPass = "a".repeat(300);
    const input = `https://user:${longPass}@github.com/org/repo.git`;
    const out = recordAndCaptureData({ remoteUrl: input });
    const result = out["remoteUrl"] as string;
    expect(result).not.toContain(longPass);
    expect(result).toContain("[redacted]");
  });

  it("redactCredentialUrls does not touch URLs without userinfo", () => {
    const input = "https://github.com/org/repo.git pushed successfully";
    const out = recordAndCaptureData({ message: input });
    expect(out["message"]).toBe(input);
  });

  it("redactCredentialUrls handles multiple credential URLs in one string", () => {
    const input = "remote: https://token123@github.com/a.git origin: https://pass@github.com/b.git";
    const out = recordAndCaptureData({ message: input });
    const result = out["message"] as string;
    expect(result).not.toContain("token123");
    expect(result).not.toContain("pass");
    expect(result).toMatch(/\[redacted\]/g);
    // Should still contain the host parts
    expect(result).toContain("github.com/a.git");
    expect(result).toContain("github.com/b.git");
  });
});
