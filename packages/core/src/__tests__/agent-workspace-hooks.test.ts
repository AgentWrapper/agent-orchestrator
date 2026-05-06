import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAgentPath,
  setupPathWrapperWorkspace,
  AO_METADATA_HELPER,
  GH_WRAPPER,
} from "../agent-workspace-hooks.js";

const { mockWriteFile, mockMkdir, mockReadFile, mockRename } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  rename: mockRename,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

describe("buildAgentPath", () => {
  it("prepends ao bin dir to PATH", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    expect(result).toMatch(/^\/home\/testuser\/.ao\/bin:/);
    expect(result).toContain("/usr/bin");
    expect(result).toContain("/bin");
  });

  it("deduplicates entries", () => {
    const result = buildAgentPath("/usr/local/bin:/usr/bin:/usr/local/bin");
    const entries = result.split(":");
    const unique = new Set(entries);
    expect(entries.length).toBe(unique.size);
  });

  it("uses default PATH when basePath is undefined", () => {
    const result = buildAgentPath(undefined);
    expect(result).toMatch(/^\/home\/testuser\/.ao\/bin:/);
    expect(result).toContain("/usr/bin");
  });

  it("ensures /usr/local/bin is early for gh resolution", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    const entries = result.split(":");
    const aoIdx = entries.indexOf("/home/testuser/.ao/bin");
    const ghIdx = entries.indexOf("/usr/local/bin");
    expect(aoIdx).toBe(0);
    expect(ghIdx).toBe(1);
  });
});

describe("setupPathWrapperWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("creates ao bin directory", async () => {
    await setupPathWrapperWorkspace("/workspace");
    expect(mockMkdir).toHaveBeenCalledWith("/home/testuser/.ao/bin", { recursive: true });
  });

  it("writes wrapper scripts when version marker is missing", async () => {
    await setupPathWrapperWorkspace("/workspace");
    // atomicWriteFile writes to .tmp then renames
    expect(mockRename).toHaveBeenCalled();
    // .ao/AGENTS.md is written directly
    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes(".ao/AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
  });

  it("skips wrapper rewrite when version matches", async () => {
    mockReadFile
      .mockResolvedValueOnce("0.6.0") // version marker matches
      .mockRejectedValueOnce(new Error("ENOENT")); // AGENTS.md doesn't exist

    await setupPathWrapperWorkspace("/workspace");

    // Only metadata helper rename (1), no gh/git/marker renames
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(renamedPaths.filter((p: string) => p.includes("/gh."))).toHaveLength(0);
    expect(renamedPaths.filter((p: string) => p.includes("/git."))).toHaveLength(0);
  });

  it("writes .ao/AGENTS.md with session context", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes(".ao/AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });
});

describe("AO_METADATA_HELPER", () => {
  it("contains update_ao_metadata function", () => {
    expect(AO_METADATA_HELPER).toContain("update_ao_metadata()");
  });

  it("contains read_ao_metadata function", () => {
    expect(AO_METADATA_HELPER).toContain("read_ao_metadata()");
  });

  it("contains cache helper functions", () => {
    expect(AO_METADATA_HELPER).toContain("ao_cache_dir()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_fresh()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_read()");
    expect(AO_METADATA_HELPER).toContain("ao_cache_write()");
  });

  it("uses .ghcache subdirectory for cache storage", () => {
    expect(AO_METADATA_HELPER).toContain(".ghcache");
  });

  it("validates environment in shared _ao_validate_env", () => {
    expect(AO_METADATA_HELPER).toContain("_ao_validate_env()");
    expect(AO_METADATA_HELPER).toContain("AO_DATA_DIR");
    expect(AO_METADATA_HELPER).toContain("AO_SESSION");
  });

  it("validates trusted roots for path traversal prevention", () => {
    expect(AO_METADATA_HELPER).toContain(".agent-orchestrator");
    expect(AO_METADATA_HELPER).toContain("/tmp/*");
  });
});

describe("GH_WRAPPER", () => {
  it("contains PR discovery cache intercept", () => {
    expect(GH_WRAPPER).toContain('$1" == "pr" && "$2" == "list"');
    expect(GH_WRAPPER).toContain("pr-disc-");
    expect(GH_WRAPPER).toContain("ao_cache_fresh");
    expect(GH_WRAPPER).toContain("ao_cache_read");
  });

  it("requires --head and --limit 1 for PR discovery cache", () => {
    expect(GH_WRAPPER).toContain("_ao_head");
    expect(GH_WRAPPER).toContain("_ao_limit");
    expect(GH_WRAPPER).toContain('"$_ao_limit" == "1"');
  });

  it("does not cache empty PR discovery results", () => {
    expect(GH_WRAPPER).toContain('"$_ao_trimmed" != "[]"');
  });

  it("passes through on unsupported flags for PR discovery", () => {
    expect(GH_WRAPPER).toContain("--search");
    expect(GH_WRAPPER).toContain("--state");
    expect(GH_WRAPPER).toContain("--assignee");
    expect(GH_WRAPPER).toContain("--label");
    expect(GH_WRAPPER).toContain("--jq");
    expect(GH_WRAPPER).toContain("--template");
    expect(GH_WRAPPER).toContain("_ao_cacheable=false");
  });

  it("passes through on unsupported --key=value flags for PR discovery", () => {
    expect(GH_WRAPPER).toContain("--search=*");
    expect(GH_WRAPPER).toContain("--state=*");
    expect(GH_WRAPPER).toContain("--jq=*");
    expect(GH_WRAPPER).toContain("--template=*");
  });

  it("contains issue context cache intercept with 300s TTL", () => {
    expect(GH_WRAPPER).toContain('$1" == "issue" && "$2" == "view"');
    expect(GH_WRAPPER).toContain("issue-");
    expect(GH_WRAPPER).toContain("ao_cache_fresh");
    expect(GH_WRAPPER).toContain("300");
  });

  it("passes through on --web and --comments for issue view", () => {
    expect(GH_WRAPPER).toContain("--web");
    expect(GH_WRAPPER).toContain("--comments");
  });

  it("includes --json fields in PR discovery cache key", () => {
    // _ao_json is captured from --json and --json= forms
    expect(GH_WRAPPER).toContain('_ao_json=""');
    expect(GH_WRAPPER).toContain('--json)     _ao_json=');
    expect(GH_WRAPPER).toContain('--json=*)   _ao_json=');
    // json fields are included in the raw key fed to sha256
    expect(GH_WRAPPER).toContain('-j-${_ao_json}');
  });

  it("includes --json fields in issue context cache key", () => {
    // Both PR discovery and issue view include --json in cache key via sha256 hash
    const issueSection = GH_WRAPPER.split('issue" && "$2" == "view"')[1];
    expect(issueSection).toContain("_ao_json");
    expect(issueSection).toContain("-j-");
  });

  it("handles --head=value and --limit=value equals-sign syntax", () => {
    expect(GH_WRAPPER).toContain('--head=*)   _ao_head="${1#--head=}"');
    expect(GH_WRAPPER).toContain('--limit=*)  _ao_limit="${1#--limit=}"');
  });

  it("does not pre-populate PR discovery cache from gh pr create", () => {
    // PR create should update metadata but NOT write to the cache,
    // because we cannot know what --json fields the next pr list will request
    expect(GH_WRAPPER).toContain("pr/create)");
    const prCreateSection = GH_WRAPPER.split("pr/create)")[1].split("exit $exit_code")[0];
    expect(prCreateSection).not.toContain("ao_cache_write");
  });

  it("only caches stdout, not stderr, in cacheable paths", () => {
    // The cacheable read paths (pr list, issue view) must redirect only stdout
    // to the temp file, letting stderr pass through to the agent.
    // Extract the two cacheable sections and verify no 2>&1 in their gh calls.
    const prSection = GH_WRAPPER.split('$1" == "pr" && "$2" == "list"')[1].split("fi\nfi")[0];
    const issueSection = GH_WRAPPER.split('$1" == "issue" && "$2" == "view"')[1].split("fi\nfi")[0];
    // The real_gh call in cache paths should NOT have 2>&1
    const prGhCall = prSection.match(/"\$real_gh" "\$@" > "\$_ao_tmpout"(.*)/)?.[1] ?? "";
    const issueGhCall = issueSection.match(/"\$real_gh" "\$@" > "\$_ao_tmpout"(.*)/)?.[1] ?? "";
    expect(prGhCall).not.toContain("2>&1");
    expect(issueGhCall).not.toContain("2>&1");
  });

  it("still passes through unmatched commands without exec", () => {
    // Default case runs real gh as child process (not exec) to allow post-call tracing
    expect(GH_WRAPPER).not.toContain('exec "$real_gh" "$@"');
    // Real gh is still called in the default case
    expect(GH_WRAPPER).toContain('"$real_gh" "$@"');
  });

  it("uses current wrapper version in trace logging", () => {
    expect(GH_WRAPPER).toContain("0.6.0");
  });

  it("logs cache outcomes (hit/miss-stored/miss-negative/miss-error) to trace", () => {
    expect(GH_WRAPPER).toContain("log_ao_cache");
    expect(GH_WRAPPER).toContain('"hit"');
    expect(GH_WRAPPER).toContain('"miss-stored"');
    expect(GH_WRAPPER).toContain('"miss-negative"');
    expect(GH_WRAPPER).toContain('"miss-error"');
    expect(GH_WRAPPER).toContain("cacheResult");
    expect(GH_WRAPPER).toContain("cacheKey");
  });

  it("logs passthrough for pr/create and default case", () => {
    // Both pr/create and the default *) case must log passthrough
    const matches = GH_WRAPPER.match(/"passthrough"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // pr/create section logs passthrough
    const prCreateSection = GH_WRAPPER.split("pr/create)")[1];
    expect(prCreateSection).toContain('"passthrough"');
  });

  it("logs miss-write-failed when cache write fails", () => {
    expect(GH_WRAPPER).toContain('"miss-write-failed"');
    // miss-stored is conditional on ao_cache_write succeeding
    const prSection = GH_WRAPPER.split('$1" == "pr" && "$2" == "list"')[1].split("fi\nfi")[0];
    expect(prSection).toContain("if ao_cache_write");
  });

  it("includes durationMs, exitCode, ok in cache outcome rows", () => {
    // log_ao_cache signature includes duration, exit code, ok
    expect(GH_WRAPPER).toContain("duration_ms");
    expect(GH_WRAPPER).toContain("exit_code");
    expect(GH_WRAPPER).toContain('"durationMs"');
    expect(GH_WRAPPER).toContain('"exitCode"');
    expect(GH_WRAPPER).toContain('"ok"');
  });

  it("captures timing around real gh calls", () => {
    // All paths that call real gh should have start/duration measurement
    expect(GH_WRAPPER).toContain("_ao_start_s=$(date +%s)");
    expect(GH_WRAPPER).toContain("_ao_duration_ms=$(");
  });

  it("includes operation field in invocation trace row", () => {
    expect(GH_WRAPPER).toContain("_ao_op=");
    expect(GH_WRAPPER).toContain("operation");
    // operation format: gh.{arg1}.{arg2}
    expect(GH_WRAPPER).toContain('"gh.$1"');
    expect(GH_WRAPPER).toContain('"gh.$1.$2"');
  });
});
