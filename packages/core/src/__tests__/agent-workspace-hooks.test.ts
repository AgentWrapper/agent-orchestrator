import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import {
  buildAgentPath,
  buildNodeWrapper,
  setupPathWrapperWorkspace,
  AO_METADATA_HELPER,
  GH_WRAPPER,
} from "../agent-workspace-hooks.js";

const { mockWriteFile, mockMkdir, mockReadFile, mockRename, mockIsWindows } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockIsWindows: vi.fn().mockReturnValue(false),
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

vi.mock("../platform.js", () => ({
  isWindows: mockIsWindows,
}));

// On Windows, path.join('/home/testuser', '.ao', 'bin') => '\home\testuser\.ao\bin'
// Use join() so assertions match the runtime path format
const AO_BIN_DIR = join("/home/testuser", ".ao", "bin");

describe("buildAgentPath", () => {
  beforeEach(() => {
    mockIsWindows.mockReturnValue(false);
  });

  it("prepends ao bin dir to PATH", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    expect(result).toContain(AO_BIN_DIR);
    expect(result.startsWith(AO_BIN_DIR)).toBe(true);
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
    expect(result).toContain(AO_BIN_DIR);
    expect(result.startsWith(AO_BIN_DIR)).toBe(true);
    expect(result).toContain("/usr/bin");
  });

  it("ensures /usr/local/bin is early for gh resolution", () => {
    const result = buildAgentPath("/usr/bin:/bin");
    const entries = result.split(":");
    const aoIdx = entries.indexOf(AO_BIN_DIR);
    const ghIdx = entries.indexOf("/usr/local/bin");
    expect(aoIdx).toBe(0);
    expect(ghIdx).toBe(1);
  });
});

describe("setupPathWrapperWorkspace (Unix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(false);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("creates ao bin directory", async () => {
    await setupPathWrapperWorkspace("/workspace");
    expect(mockMkdir).toHaveBeenCalledWith(AO_BIN_DIR, { recursive: true });
  });

  it("writes wrapper scripts when version marker is missing", async () => {
    await setupPathWrapperWorkspace("/workspace");
    // atomicWriteFile writes to .tmp then renames
    expect(mockRename).toHaveBeenCalled();
    // .ao/AGENTS.md is written directly (path.join may use / or \ depending on platform)
    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
  });

  it("skips wrapper rewrite when version matches", async () => {
    mockReadFile
      .mockResolvedValueOnce("0.7.0") // version marker matches
      .mockRejectedValueOnce(new Error("ENOENT")); // AGENTS.md doesn't exist

    await setupPathWrapperWorkspace("/workspace");

    // No gh/git/marker renames when version matches
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(renamedPaths.filter((p: string) => p.includes("gh."))).toHaveLength(0);
    expect(renamedPaths.filter((p: string) => p.includes("git."))).toHaveLength(0);
  });

  it("writes .ao/AGENTS.md with session context", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });

  it("writes bash wrappers (not .cmd) on Unix", async () => {
    await setupPathWrapperWorkspace("/workspace");

    const writtenPaths = mockWriteFile.mock.calls.map((c: unknown[]) => String(c[0]));
    const renamedPaths = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));
    const allPaths = [...writtenPaths, ...renamedPaths];

    // Should have bash scripts for gh and git (no extension)
    const hasBashGh = allPaths.some((p: string) => p.endsWith("/gh") || p.endsWith("\\gh"));
    const hasBashGit = allPaths.some((p: string) => p.endsWith("/git") || p.endsWith("\\git"));
    expect(hasBashGh).toBe(true);
    expect(hasBashGit).toBe(true);

    // Should NOT have .cmd shims on Unix
    const hasCmdFiles = allPaths.some((p: string) => p.endsWith(".cmd"));
    expect(hasCmdFiles).toBe(false);
  });
});

describe("setupPathWrapperWorkspace (Windows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  it("generates .cmd shims instead of bash scripts", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    // atomicWriteFile: writeFile(tmp) -> rename(tmp, final)
    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasCmdGh = renamedFinal.some((p: string) => p.endsWith("gh.cmd"));
    const hasCmdGit = renamedFinal.some((p: string) => p.endsWith("git.cmd"));
    expect(hasCmdGh).toBe(true);
    expect(hasCmdGit).toBe(true);
  });

  it("generates .cjs wrapper files on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    const hasCjsGh = renamedFinal.some((p: string) => p.endsWith("gh.cjs"));
    const hasCjsGit = renamedFinal.some((p: string) => p.endsWith("git.cjs"));
    expect(hasCjsGh).toBe(true);
    expect(hasCjsGit).toBe(true);
  });

  it("does NOT generate bash wrappers on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));

    // Bash wrappers have no extension — check nothing ends with just /gh or \gh
    const hasBashGh = renamedFinal.some((p: string) => p.endsWith("/gh") || p.endsWith("\\gh"));
    const hasBashGit = renamedFinal.some((p: string) => p.endsWith("/git") || p.endsWith("\\git"));
    expect(hasBashGh).toBe(false);
    expect(hasBashGit).toBe(false);
  });

  it("does NOT generate ao-metadata-helper.sh on Windows", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const renamedFinal = mockRename.mock.calls.map((c: unknown[]) => String(c[1]));
    const hasHelper = renamedFinal.some((p: string) => p.includes("ao-metadata-helper"));
    expect(hasHelper).toBe(false);
  });

  it(".cmd shim content delegates to node wrapper", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    // Find .cmd write content — tmp file is written then renamed
    const tmpWrites = mockWriteFile.mock.calls;
    const cmdWrite = tmpWrites.find((c: unknown[]) => {
      const content = String(c[1]);
      return content.includes("@node") && content.includes("%~dp0");
    });
    expect(cmdWrite).toBeDefined();
    expect(String(cmdWrite![1])).toMatch(/@node "%~dp0(gh|git)\.cjs" %\*/);
  });

  it("writes .ao/AGENTS.md on Windows too", async () => {
    await setupPathWrapperWorkspace("C:\\workspace");

    const agentsMdWrites = mockWriteFile.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("AGENTS.md"),
    );
    expect(agentsMdWrites).toHaveLength(1);
    expect(String(agentsMdWrites[0][1])).toContain("Agent Orchestrator");
  });

  it("uses semicolon as PATH delimiter on Windows", () => {
    const result = buildAgentPath("C:\\tools;C:\\Windows\\System32");
    // On Windows, delimiter should be ;
    expect(result).toContain(";");
    expect(result).toContain("C:\\tools");
    expect(result).toContain("C:\\Windows\\System32");
    // The ao bin dir should be first entry (joined with ;)
    const entries = result.split(";");
    expect(entries[0]).toBe(AO_BIN_DIR);
  });
});

describe("buildNodeWrapper", () => {
  it("gh wrapper contains PR URL extraction pattern", () => {
    const script = buildNodeWrapper("gh", "");
    expect(script).toContain("pr/create");
    expect(script).toContain("pr/merge");
    // The regex pattern for github PR URLs (escaped inside a JS regex literal in the generated script)
    expect(script).toContain("github");
    expect(script).toContain("pull");
    expect(script).toContain("updateAoMetadata");
  });

  it("gh wrapper contains metadata update calls for pr_open", () => {
    const script = buildNodeWrapper("gh", "");
    expect(script).toContain("pr_open");
    expect(script).toContain('"pr"');
    expect(script).toContain('"status"');
  });

  it("git wrapper intercepts checkout -b and switch -c", () => {
    const script = buildNodeWrapper("git", "");
    expect(script).toContain("checkout/-b");
    expect(script).toContain("switch/-c");
    expect(script).toContain("updateAoMetadata");
    expect(script).toContain('"branch"');
  });

  it("git wrapper skips non-feature branches", () => {
    const script = buildNodeWrapper("git", "");
    // The script should check for / or - in branch name
    expect(script).toContain('branch.includes("/") || branch.includes("-")');
  });

  it("wrappers use path.delimiter for PATH splitting", () => {
    const ghScript = buildNodeWrapper("gh", "");
    const gitScript = buildNodeWrapper("git", "");
    expect(ghScript).toContain("path.delimiter");
    expect(gitScript).toContain("path.delimiter");
  });

  it("gh wrapper uses explicit realBinaryPath when provided, with existsSync fallback", () => {
    const script = buildNodeWrapper("gh", "C:\\tools\\gh.exe");
    expect(script).toContain("C:\\\\tools\\\\gh.exe");
    // fallback must NOT be dead code — fs.existsSync guard ensures findRealGh() runs
    // when the hardcoded path is missing at runtime
    expect(script).toContain("fs.existsSync");
    expect(script).toContain("findRealGh()");
  });

  it("updateAoMetadata in node wrappers handles V2 .json metadata format", () => {
    const ghScript = buildNodeWrapper("gh", "");
    // Must try the .json extension first (V2 storage format)
    expect(ghScript).toContain('aoSession + ".json"');
    // Must fall back to bare name (V1 legacy format)
    expect(ghScript).toContain("path.join(resolvedDir, aoSession)");
    // Must handle JSON.parse/stringify for V2 format
    expect(ghScript).toContain("JSON.parse");
    expect(ghScript).toContain("JSON.stringify");
    // Must handle key=value lines for V1 format
    expect(ghScript).toContain('split("\\n")');
  });

  it("updateAoMetadata is shared between gh and git wrappers", () => {
    const ghScript = buildNodeWrapper("gh", "");
    const gitScript = buildNodeWrapper("git", "");
    // Both wrappers should contain the V2 JSON format support
    expect(ghScript).toContain('aoSession + ".json"');
    expect(gitScript).toContain('aoSession + ".json"');
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
    expect(GH_WRAPPER).toContain("--json)     _ao_json=");
    expect(GH_WRAPPER).toContain("--json=*)   _ao_json=");
    // json fields are included in the raw key fed to sha256
    expect(GH_WRAPPER).toContain("-j-${_ao_json}");
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
    expect(GH_WRAPPER).toContain("0.7.0");
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
