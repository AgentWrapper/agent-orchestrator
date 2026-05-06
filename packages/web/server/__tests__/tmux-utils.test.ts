/**
 * Unit tests for tmux-utils.
 *
 * These test actual behavior by injecting mock execFileSync functions,
 * verifying the logic handles all edge cases correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { findTmux, resolveTmuxSession, validateSessionId, SESSION_ID_PATTERN } from "../tmux-utils.js";

// Default fs adapter for resolveTmuxSession tests — empty AO base directory
// so the on-disk storageKey lookup always misses and we exercise the
// tmux-listing fallback. Tests that want to exercise the on-disk lookup
// path provide their own FsAdapter explicitly.
const emptyFs = {
  readdir: () => [],
  exists: () => false,
  homedir: () => "/tmp/ao-test-home-that-does-not-exist",
};

// =============================================================================
// validateSessionId
// =============================================================================

describe("validateSessionId", () => {
  describe("accepts valid IDs", () => {
    it("accepts simple alphanumeric IDs", () => {
      expect(validateSessionId("ao-15")).toBe(true);
      expect(validateSessionId("ao_orchestrator")).toBe(true);
      expect(validateSessionId("session123")).toBe(true);
    });

    it("accepts hash-prefixed IDs", () => {
      expect(validateSessionId("8474d6f29887-ao-15")).toBe(true);
      expect(validateSessionId("abcdef123456-my-session")).toBe(true);
    });

    it("accepts single character IDs", () => {
      expect(validateSessionId("a")).toBe(true);
      expect(validateSessionId("1")).toBe(true);
      expect(validateSessionId("-")).toBe(true);
      expect(validateSessionId("_")).toBe(true);
    });

    it("accepts numbers-only IDs", () => {
      expect(validateSessionId("12345")).toBe(true);
      expect(validateSessionId("0")).toBe(true);
    });

    it("accepts hyphens and underscores only", () => {
      expect(validateSessionId("---")).toBe(true);
      expect(validateSessionId("___")).toBe(true);
      expect(validateSessionId("-_-")).toBe(true);
    });

    it("accepts uppercase letters", () => {
      expect(validateSessionId("AO-15")).toBe(true);
      expect(validateSessionId("MySession")).toBe(true);
      expect(validateSessionId("ALLCAPS")).toBe(true);
    });

    it("accepts long session IDs", () => {
      const longId = "a".repeat(200);
      expect(validateSessionId(longId)).toBe(true);
    });

    it("accepts realistic session names from the orchestrator", () => {
      expect(validateSessionId("ao-orchestrator")).toBe(true);
      expect(validateSessionId("ao-1")).toBe(true);
      expect(validateSessionId("ao-99")).toBe(true);
      expect(validateSessionId("integrator-44")).toBe(true);
      expect(validateSessionId("splitly-3")).toBe(true);
      expect(validateSessionId("8474d6f29887-ao-15")).toBe(true);
      expect(validateSessionId("deadbeef1234-integrator-7")).toBe(true);
    });
  });

  describe("rejects empty and whitespace", () => {
    it("rejects empty string", () => {
      expect(validateSessionId("")).toBe(false);
    });

    it("rejects spaces", () => {
      expect(validateSessionId("ao 15")).toBe(false);
      expect(validateSessionId(" ao-15")).toBe(false);
      expect(validateSessionId("ao-15 ")).toBe(false);
      expect(validateSessionId(" ")).toBe(false);
    });

    it("rejects tabs and newlines", () => {
      expect(validateSessionId("ao\t15")).toBe(false);
      expect(validateSessionId("ao\n15")).toBe(false);
      expect(validateSessionId("ao\r15")).toBe(false);
      expect(validateSessionId("\t")).toBe(false);
    });
  });

  describe("rejects path traversal", () => {
    it("rejects dot-dot-slash sequences", () => {
      expect(validateSessionId("../etc/passwd")).toBe(false);
      expect(validateSessionId("ao-15/../../secret")).toBe(false);
      expect(validateSessionId("..")).toBe(false);
    });

    it("rejects forward slashes", () => {
      expect(validateSessionId("ao/15")).toBe(false);
      expect(validateSessionId("/etc/passwd")).toBe(false);
      expect(validateSessionId("a/b")).toBe(false);
    });

    it("rejects backslashes", () => {
      expect(validateSessionId("ao\\15")).toBe(false);
      expect(validateSessionId("..\\..\\secret")).toBe(false);
    });

    it("rejects dots (current directory reference)", () => {
      expect(validateSessionId(".")).toBe(false);
      expect(validateSessionId("ao.15")).toBe(false);
    });
  });

  describe("rejects shell injection", () => {
    it("rejects semicolons", () => {
      expect(validateSessionId("ao-15; rm -rf /")).toBe(false);
      expect(validateSessionId(";id")).toBe(false);
    });

    it("rejects command substitution", () => {
      expect(validateSessionId("ao-15$(whoami)")).toBe(false);
      expect(validateSessionId("$(cat /etc/passwd)")).toBe(false);
    });

    it("rejects backticks", () => {
      expect(validateSessionId("ao-15`id`")).toBe(false);
      expect(validateSessionId("`rm -rf /`")).toBe(false);
    });

    it("rejects pipes", () => {
      expect(validateSessionId("ao-15|cat /etc/passwd")).toBe(false);
      expect(validateSessionId("|id")).toBe(false);
    });

    it("rejects ampersands", () => {
      expect(validateSessionId("ao-15&sleep 10")).toBe(false);
      expect(validateSessionId("ao-15&&id")).toBe(false);
    });

    it("rejects angle brackets (redirection)", () => {
      expect(validateSessionId("ao-15>output")).toBe(false);
      expect(validateSessionId("ao-15<input")).toBe(false);
    });

    it("rejects quotes", () => {
      expect(validateSessionId("ao-15'")).toBe(false);
      expect(validateSessionId('ao-15"')).toBe(false);
    });

    it("rejects dollar signs", () => {
      expect(validateSessionId("$HOME")).toBe(false);
      expect(validateSessionId("ao-${15}")).toBe(false);
    });

    it("rejects parentheses", () => {
      expect(validateSessionId("ao(15)")).toBe(false);
      expect(validateSessionId("(id)")).toBe(false);
    });

    it("rejects hash/pound sign", () => {
      expect(validateSessionId("ao#15")).toBe(false);
      expect(validateSessionId("#comment")).toBe(false);
    });

    it("rejects exclamation mark", () => {
      expect(validateSessionId("ao!15")).toBe(false);
    });

    it("rejects asterisk and question mark (glob)", () => {
      expect(validateSessionId("ao*")).toBe(false);
      expect(validateSessionId("ao?15")).toBe(false);
    });

    it("rejects tilde (home directory)", () => {
      expect(validateSessionId("~")).toBe(false);
      expect(validateSessionId("~/something")).toBe(false);
    });
  });

  describe("rejects other dangerous characters", () => {
    it("rejects null bytes", () => {
      expect(validateSessionId("ao\x0015")).toBe(false);
    });

    it("rejects unicode", () => {
      expect(validateSessionId("ao-\u00e9")).toBe(false);
      expect(validateSessionId("ao-\u200b15")).toBe(false); // zero-width space
    });

    it("rejects control characters", () => {
      expect(validateSessionId("ao\x01")).toBe(false);
      expect(validateSessionId("ao\x7f")).toBe(false); // DEL
    });

    it("rejects percent (URL encoding attempts)", () => {
      expect(validateSessionId("ao%2F15")).toBe(false);
      expect(validateSessionId("%00")).toBe(false);
    });

    it("rejects at sign", () => {
      expect(validateSessionId("user@host")).toBe(false);
    });

    it("rejects colons", () => {
      expect(validateSessionId("ao:15")).toBe(false);
    });

    it("rejects equals sign", () => {
      expect(validateSessionId("ao=15")).toBe(false);
    });

    it("rejects square brackets", () => {
      expect(validateSessionId("ao[15]")).toBe(false);
    });

    it("rejects curly braces", () => {
      expect(validateSessionId("ao{15}")).toBe(false);
    });

    it("rejects comma", () => {
      expect(validateSessionId("ao,15")).toBe(false);
    });
  });

  describe("SESSION_ID_PATTERN export", () => {
    it("is exported and matches the same pattern", () => {
      expect(SESSION_ID_PATTERN).toBeInstanceOf(RegExp);
      expect(SESSION_ID_PATTERN.test("ao-15")).toBe(true);
      expect(SESSION_ID_PATTERN.test("../bad")).toBe(false);
    });
  });
});

// =============================================================================
// findTmux
// =============================================================================

describe("findTmux", () => {
  it("returns first candidate that succeeds", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw new Error("not found"); }) // /opt/homebrew/bin/tmux
      .mockImplementationOnce(() => "tmux 3.4") // /usr/local/bin/tmux succeeds
      .mockImplementationOnce(() => "tmux 3.4"); // /usr/bin/tmux (not reached)

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/local/bin/tmux");
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("returns /opt/homebrew/bin/tmux on macOS ARM (first candidate)", () => {
    const mockExec = vi.fn().mockReturnValue("tmux 3.4");

    const result = findTmux(mockExec);

    expect(result).toBe("/opt/homebrew/bin/tmux");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("returns /usr/bin/tmux on Linux (third candidate)", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw new Error("not found"); }) // /opt/homebrew/bin/tmux
      .mockImplementationOnce(() => { throw new Error("not found"); }) // /usr/local/bin/tmux
      .mockImplementationOnce(() => "tmux 3.3a"); // /usr/bin/tmux

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/bin/tmux");
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("falls back to bare 'tmux' when no candidates found", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findTmux(mockExec);

    expect(result).toBe("tmux");
    expect(mockExec).toHaveBeenCalledTimes(3);
  });

  it("checks all three standard locations in order", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });

    findTmux(mockExec);

    expect(mockExec).toHaveBeenNthCalledWith(1, "/opt/homebrew/bin/tmux", ["-V"], { timeout: 5000 });
    expect(mockExec).toHaveBeenNthCalledWith(2, "/usr/local/bin/tmux", ["-V"], { timeout: 5000 });
    expect(mockExec).toHaveBeenNthCalledWith(3, "/usr/bin/tmux", ["-V"], { timeout: 5000 });
  });

  it("handles timeout errors from execFileSync", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); })
      .mockImplementationOnce(() => "tmux 3.4");

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/local/bin/tmux");
  });

  it("handles permission denied errors", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })
      .mockImplementationOnce(() => "tmux 3.3a");

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/bin/tmux");
  });

  it("handles ENOENT (file not found) errors", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })
      .mockImplementationOnce(() => "tmux 3.4");

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/local/bin/tmux");
  });

  it("passes -V flag and 5000ms timeout to each candidate", () => {
    const mockExec = vi.fn().mockReturnValue("tmux 3.4");

    findTmux(mockExec);

    const [, args, options] = mockExec.mock.calls[0];
    expect(args).toEqual(["-V"]);
    expect(options).toEqual({ timeout: 5000 });
  });

  it("stops checking after first success (short-circuit)", () => {
    const mockExec = vi.fn().mockReturnValue("tmux 3.4");

    findTmux(mockExec);

    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// resolveTmuxSession
// =============================================================================

describe("resolveTmuxSession", () => {
  const TMUX = "/opt/homebrew/bin/tmux";

  // ---------------------------------------------------------------------------
  // Exact match behavior
  // ---------------------------------------------------------------------------

  describe("exact match", () => {
    it("returns sessionId for exact match", () => {
      const mockExec = vi.fn().mockReturnValue("");

      const result = resolveTmuxSession("ao-orchestrator", TMUX, mockExec, emptyFs);

      expect(result).toBe("ao-orchestrator");
    });

    it("uses = prefix to prevent tmux prefix matching", () => {
      // This is the critical bugbot fix: without =, "ao-1" matches "ao-15"
      const mockExec = vi.fn().mockReturnValue("");

      resolveTmuxSession("ao-1", TMUX, mockExec, emptyFs);

      // Must pass "=ao-1" not "ao-1" to has-session
      expect(mockExec).toHaveBeenCalledWith(
        TMUX,
        ["has-session", "-t", "=ao-1"],
        { timeout: 5000 },
      );
    });

    it("passes correct tmux path and timeout to has-session", () => {
      const customTmux = "/usr/bin/tmux";
      const mockExec = vi.fn().mockReturnValue("");

      resolveTmuxSession("my-session", customTmux, mockExec, emptyFs);

      expect(mockExec).toHaveBeenCalledWith(
        customTmux,
        ["has-session", "-t", "=my-session"],
        { timeout: 5000 },
      );
    });

    it("prefers exact match over hash-prefixed match", () => {
      // If "ao-15" exists as both exact and hash-prefixed, return exact
      const mockExec = vi.fn().mockReturnValue("");

      const result = resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs);

      expect(result).toBe("ao-15");
      // Should only call has-session, not list-sessions
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it("does not call list-sessions when exact match succeeds", () => {
      const mockExec = vi.fn().mockReturnValue("");

      resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs);

      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec).toHaveBeenCalledWith(
        TMUX,
        ["has-session", "-t", "=ao-15"],
        { timeout: 5000 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Hash-prefix resolution
  // ---------------------------------------------------------------------------

  describe("hash-prefix resolution", () => {
    it("resolves hash-prefixed session when exact match fails", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "8474d6f29887-ao-15\na1b2c3d4e5f6-ao-16\nao-orchestrator\n";
        });

      const result = resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs);

      expect(result).toBe("8474d6f29887-ao-15");
    });

    it("uses exact match after hash prefix (not endsWith)", () => {
      // "ao-1" should NOT match "8474d6f29887-ao-15" because substring(13) is "ao-15" not "ao-1"
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "8474d6f29887-ao-15\n8474d6f29887-ao-16\n";
        });

      const result = resolveTmuxSession("ao-1", TMUX, mockExec, emptyFs);

      expect(result).toBeNull();
    });

    it("does NOT match ambiguous suffixes (bugbot: hash-my-app-1 vs app-1)", () => {
      // This is the critical bugbot fix: "hash-my-app-1" ends with "-app-1"
      // but the hash prefix is not a valid 12-char hex string, so it shouldn't match.
      // A user looking up "app-1" should NOT be connected to "hash-my-app-1".
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "nonhexprefix-my-app-1\n8474d6f29887-app-1\n";
        });

      // Should match the one with valid hash prefix, not the ambiguous one
      expect(resolveTmuxSession("app-1", TMUX, mockExec, emptyFs)).toBe("8474d6f29887-app-1");
    });

    it("rejects session names where hash prefix is not 12-char hex", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          // These look like hash-prefixed but aren't valid 12-char hex
          return [
            "short-ao-15",                   // too short
            "toolonghashprefix-ao-15",        // too long
            "ABCDEF123456-ao-15",             // uppercase hex (not matching [a-f0-9])
            "zzzzzzzzzzzz-ao-15",             // not hex chars
            "8474d6f2988-ao-15",              // 11 chars (one short)
            "8474d6f29887a-ao-15",            // 13 chars (one extra)
          ].join("\n") + "\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("only matches valid 12-char lowercase hex prefix", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "abcdef012345-ao-15\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBe("abcdef012345-ao-15");
    });

    it("matches the correct session among many", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return [
            "aabbccddeef0-ao-1",
            "112233445566-ao-15",
            "ffeeddccbbaa-ao-2",
            "a0b1c2d3e4f5-ao-orchestrator",
          ].join("\n") + "\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBe("112233445566-ao-15");
    });

    it("matches ao-1 to hash-ao-1 (not hash-ao-15)", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return [
            "aabbccddeef0-ao-1",
            "112233445566-ao-15",
            "ffeeddccbbaa-ao-2",
          ].join("\n") + "\n";
        });

      expect(resolveTmuxSession("ao-1", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-ao-1");
    });

    it("matches session with multiple hyphens in name", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-my-long-session-name\n112233445566-other-session\n";
        });

      expect(resolveTmuxSession("my-long-session-name", TMUX, mockExec, emptyFs))
        .toBe("aabbccddeef0-my-long-session-name");
    });

    it("matches session with underscores", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-my_session\n112233445566-other_session\n";
        });

      expect(resolveTmuxSession("my_session", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-my_session");
    });

    it("passes list-sessions format flag correctly", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "some-session\n";
        });

      resolveTmuxSession("ao-99", TMUX, mockExec, emptyFs);

      expect(mockExec).toHaveBeenNthCalledWith(2,
        TMUX,
        ["list-sessions", "-F", "#{session_name}"],
        { timeout: 5000, encoding: "utf8" },
      );
    });

    it("does NOT match if session name contains the ID but not after hash prefix", () => {
      // e.g., "ao-15-extended" has no valid hash prefix
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "ao-15-extended\nao-15-backup\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("does NOT match hash-prefixed session with extra suffix", () => {
      // "aabbccddeef0-ao-15-backup" has valid hash but substring(13) is "ao-15-backup"
      // which neither equals "ao-15" nor ends with "-ao-15".
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-15-backup\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("resolves wrapped-storageKey session via on-disk lookup (issue #1486)", () => {
      // Issue #1486: when the project config uses a wrapped storageKey like
      // "361287ebbad1-smx-foundation", ao-core names the tmux session
      // "361287ebbad1-smx-foundation-sf-orchestrator-1". The resolver must
      // find the storageKey on disk (from the session file at
      // ~/.agent-orchestrator/361287ebbad1-smx-foundation/sessions/sf-orchestrator-1)
      // and then ask tmux whether the full `{storageKey}-{sessionId}` exists.
      const fs = {
        readdir: () => ["361287ebbad1-smx-foundation", "other-unrelated-dir"],
        exists: (p: string) => p.endsWith("/361287ebbad1-smx-foundation/sessions/sf-orchestrator-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // exact match fails
        })
        .mockImplementationOnce(() => {
          return ""; // has-session on full tmux name succeeds (no throw)
        });

      const result = resolveTmuxSession("sf-orchestrator-1", TMUX, mockExec, fs);

      expect(result).toBe("361287ebbad1-smx-foundation-sf-orchestrator-1");
      // Verifies the resolver asks tmux for the exact `{storageKey}-{sessionId}` name.
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        TMUX,
        ["has-session", "-t", "=361287ebbad1-smx-foundation-sf-orchestrator-1"],
        { timeout: 5000 },
      );
    });

    it("resolves bare-hash session via on-disk lookup", () => {
      const fs = {
        readdir: () => ["aabbccddeef0"],
        exists: (p: string) => p.endsWith("/aabbccddeef0/sessions/ao-15"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, fs)).toBe("aabbccddeef0-ao-15");
    });

    it("does NOT false-match app-1 against bare session my-app-1 (codex review concern)", () => {
      // Critical: a bare-hash session `aabbccddeef0-my-app-1` has sessionId
      // `my-app-1`. When a user asks for `app-1`, the resolver must NOT return
      // it — the trailing `-app-1` is coincidental. The on-disk lookup finds
      // no `app-1` session, and the tmux-listing fallback only accepts exact
      // remainder matches, so this correctly returns null.
      const fs = {
        readdir: () => ["aabbccddeef0"],
        // Only my-app-1 exists on disk, app-1 does not.
        exists: (p: string) => p.endsWith("/aabbccddeef0/sessions/my-app-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // exact match on "app-1" fails
        })
        .mockImplementationOnce(() => {
          // list-sessions fallback sees my-app-1
          return "aabbccddeef0-my-app-1\n";
        });

      expect(resolveTmuxSession("app-1", TMUX, mockExec, fs)).toBeNull();
    });

    it("does NOT false-match when wrapped session belongs to a different project", () => {
      // Storage key `aabbccddeef0-other-project` owns sessionId `app-1`.
      // A user looking up `app-1` for a DIFFERENT project (with storageKey
      // we don't have on disk) must not attach to the wrong project.
      // With on-disk lookup, we find the right storageKey unambiguously.
      const fs = {
        readdir: () => ["aabbccddeef0-other-project", "112233445566-my-project"],
        exists: (p: string) =>
          p.endsWith("/112233445566-my-project/sessions/app-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return ""; // has-session on the correct name succeeds
        });

      const result = resolveTmuxSession("app-1", TMUX, mockExec, fs);

      expect(result).toBe("112233445566-my-project-app-1");
    });

    it("falls back to tmux list when on-disk session record is missing (bare hash)", () => {
      // If the on-disk sessions/{sessionId} record is missing (e.g. filesystem
      // scrubbed), we still recover bare-hash sessions via the list-sessions
      // fallback. Wrapped-storageKey sessions cannot be safely recovered
      // without the on-disk record — that's the intended safety trade-off.
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-15\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-ao-15");
    });

    it("does NOT match sessions without a valid hex hash prefix via fallback", () => {
      // Safety: non-hex prefixes must never be treated as ao sessions.
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "nonhexprefix-smx-foundation-sf-orchestrator-1\n";
        });

      expect(resolveTmuxSession("sf-orchestrator-1", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("probes later candidates when earlier storageKey has no live tmux session", () => {
      // Two projects both have sessionId `app-1` on disk. The first one
      // (alphabetically) has a stale metadata dir but no live tmux session.
      // The resolver must continue to the next candidate and find the live one.
      const fs = {
        readdir: () => [
          "aaaaaaaaaaaa-stale-project",
          "bbbbbbbbbbbb-live-project",
        ],
        exists: (p: string) =>
          p.endsWith("/aaaaaaaaaaaa-stale-project/sessions/app-1") ||
          p.endsWith("/bbbbbbbbbbbb-live-project/sessions/app-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // exact match fails
        })
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // stale candidate has no tmux session
        })
        .mockImplementationOnce(() => {
          return ""; // live candidate has tmux session
        });

      const result = resolveTmuxSession("app-1", TMUX, mockExec, fs);

      expect(result).toBe("bbbbbbbbbbbb-live-project-app-1");
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        TMUX,
        ["has-session", "-t", "=aaaaaaaaaaaa-stale-project-app-1"],
        { timeout: 5000 },
      );
      expect(mockExec).toHaveBeenNthCalledWith(
        3,
        TMUX,
        ["has-session", "-t", "=bbbbbbbbbbbb-live-project-app-1"],
        { timeout: 5000 },
      );
    });

    it("prefers the project-scoped storageKey when session IDs collide", () => {
      const fs = {
        readdir: () => [
          "aaaaaaaaaaaa-alpha",
          "bbbbbbbbbbbb-beta",
        ],
        exists: (p: string) =>
          p.endsWith("/aaaaaaaaaaaa-alpha/sessions/app-1") ||
          p.endsWith("/bbbbbbbbbbbb-beta/sessions/app-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // exact match fails
        })
        .mockImplementationOnce(() => {
          return ""; // project-scoped candidate succeeds
        });

      const result = resolveTmuxSession("app-1", TMUX, mockExec, fs, "beta");

      expect(result).toBe("bbbbbbbbbbbb-beta-app-1");
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        TMUX,
        ["has-session", "-t", "=bbbbbbbbbbbb-beta-app-1"],
        { timeout: 5000 },
      );
    });

    it("does not treat suffix project names as exact project matches", () => {
      const fs = {
        readdir: () => [
          "aaaaaaaaaaaa-my-app",
          "bbbbbbbbbbbb-app",
        ],
        exists: (p: string) =>
          p.endsWith("/aaaaaaaaaaaa-my-app/sessions/app-1") ||
          p.endsWith("/bbbbbbbbbbbb-app/sessions/app-1"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // exact match fails
        })
        .mockImplementationOnce(() => {
          return ""; // correctly probes exact project match first
        });

      const result = resolveTmuxSession("app-1", TMUX, mockExec, fs, "app");

      expect(result).toBe("bbbbbbbbbbbb-app-app-1");
      expect(mockExec).toHaveBeenNthCalledWith(
        2,
        TMUX,
        ["has-session", "-t", "=bbbbbbbbbbbb-app-app-1"],
        { timeout: 5000 },
      );
    });

    it("accepts wrapped storageKeys with spaces/unicode in the project name", () => {
      // Legacy storageKeys use basename(projectPath), which has no character
      // restrictions on-disk. Regexes that reject spaces or unicode would
      // strand these projects the same way the bare-hash-only regex did.
      const fs = {
        readdir: () => ["aabbccddeef0-My App (v2)"],
        exists: (p: string) => p.endsWith("/aabbccddeef0-My App (v2)/sessions/ao-15"),
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, fs))
        .toBe("aabbccddeef0-My App (v2)-ao-15");
    });

    it("ignores AO base directories that don't match the storageKey pattern", () => {
      // Files like `.DS_Store`, `portfolio`, `{hash}-observability` exist in
      // the AO base. Only `{12-hex}` and `{12-hex}-{projectName}` are valid
      // storageKeys. Extraneous entries must not be probed for sessions.
      const probed: string[] = [];
      const fs = {
        readdir: () => [".DS_Store", "portfolio", "aabbccddeef0-observability", "aabbccddeef0"],
        exists: (p: string) => {
          probed.push(p);
          return p.endsWith("/aabbccddeef0/sessions/ao-15");
        },
        homedir: () => "/home/user",
      };
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "";
        });

      const result = resolveTmuxSession("ao-15", TMUX, mockExec, fs);

      expect(result).toBe("aabbccddeef0-ao-15");
      // observability dir is a valid storageKey-pattern match ({hash}-{name})
      // so it will be probed, but `.DS_Store` and `portfolio` must not be.
      expect(probed.some((p) => p.includes("/.DS_Store/"))).toBe(false);
      expect(probed.some((p) => p.includes("/portfolio/"))).toBe(false);
    });

    it("returns first match when multiple hash-prefixed sessions exist for same ID", () => {
      // This shouldn't happen in practice, but test the behavior
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-15\n112233445566-ao-15\n";
        });

      // find() returns the first match
      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-ao-15");
    });
  });

  // ---------------------------------------------------------------------------
  // Not found scenarios
  // ---------------------------------------------------------------------------

  describe("not found", () => {
    it("returns null when no session matches", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "some-other-session\nanother-session\n";
        });

      expect(resolveTmuxSession("ao-99", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("returns null when tmux is not running", () => {
      const mockExec = vi.fn().mockImplementation(() => {
        throw new Error("no server running on /tmp/tmux-501/default");
      });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("returns null when list-sessions returns empty string", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("returns null when list-sessions returns only newlines", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "\n\n\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("returns null when list-sessions throws (no sessions exist)", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found"); // has-session fails
        })
        .mockImplementationOnce(() => {
          throw new Error("no sessions"); // list-sessions fails
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("returns null when has-session times out and list-sessions is empty", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
        })
        .mockImplementationOnce(() => {
          return "\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles session name that looks like a hash (all hex chars)", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-abcdef123456\n";
        });

      expect(resolveTmuxSession("abcdef123456", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-abcdef123456");
    });

    it("handles single-char session ID", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-a\n112233445566-b\n";
        });

      expect(resolveTmuxSession("a", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-a");
    });

    it("does not match session without valid hash prefix", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "xao-15\nnotahash-ao-15\n";
        });

      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("handles Windows-style line endings in list-sessions output", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-15\r\n112233445566-ao-16\r\n";
        });

      // \r will remain in the session name after split("\n")
      // substring(13) of "aabbccddeef0-ao-15\r" is "ao-15\r" which !== "ao-15"
      // This documents the current behavior — tmux shouldn't produce \r\n on unix
      expect(resolveTmuxSession("ao-15", TMUX, mockExec, emptyFs)).toBeNull();
    });

    it("handles very long session list", () => {
      // Generate 100 sessions with valid 12-char hex prefixes
      const sessions = Array.from({ length: 100 }, (_, i) => {
        const hex = i.toString(16).padStart(12, "0");
        return `${hex}-session-${i}`;
      }).join("\n") + "\n";
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => sessions);

      const hex50 = (50).toString(16).padStart(12, "0");
      expect(resolveTmuxSession("session-50", TMUX, mockExec, emptyFs)).toBe(`${hex50}-session-50`);
    });

    it("handles session list where target is last entry", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-1\n112233445566-ao-2\nffeeddccbbaa-ao-3\na0b1c2d3e4f5-ao-target\n";
        });

      expect(resolveTmuxSession("ao-target", TMUX, mockExec, emptyFs)).toBe("a0b1c2d3e4f5-ao-target");
    });

    it("handles session list where target is first entry", () => {
      const mockExec = vi.fn()
        .mockImplementationOnce(() => {
          throw new Error("session not found");
        })
        .mockImplementationOnce(() => {
          return "aabbccddeef0-ao-target\n112233445566-ao-2\nffeeddccbbaa-ao-3\n";
        });

      expect(resolveTmuxSession("ao-target", TMUX, mockExec, emptyFs)).toBe("aabbccddeef0-ao-target");
    });

    it("works with different tmux paths", () => {
      const paths = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "tmux"];

      for (const tmuxPath of paths) {
        const mockExec = vi.fn().mockReturnValue("");
        resolveTmuxSession("ao-15", tmuxPath, mockExec, emptyFs);
        expect(mockExec).toHaveBeenCalledWith(tmuxPath, ["has-session", "-t", "=ao-15"], { timeout: 5000 });
      }
    });
  });
});
