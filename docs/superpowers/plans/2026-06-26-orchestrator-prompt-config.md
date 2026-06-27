# orchestratorPrompt Config Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional per-project `orchestratorPrompt` that replaces the built-in orchestrator standing instructions for that project's orchestrator sessions.

**Architecture:** New string field on `domain.ProjectConfig` (one JSON blob, no migration). `buildSystemPrompt` loads it and uses it as the orchestrator base when set, else the built-in; the confidentiality guard is still appended. CLI sets it via a new `--orchestrator-prompt-file <path|->` flag and via `--config-json`. `domain.ProjectConfig` is reflected into OpenAPI, so the spec/TS types are regenerated.

**Tech Stack:** Go (backend, Cobra CLI), `npm run api` (openapi-typescript) for generated artifacts.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-26-orchestrator-prompt-config.md`.
- Config endpoints use a **strict decoder** — a new field must be added to the typed `domain.ProjectConfig` (the service input is `{ Config domain.ProjectConfig }`).
- `set-config` is **replace-semantics**; do not change that.
- Keep changes surgical (AGENTS.md): no drive-by refactors (do **not** refactor `review.go`'s reader — replicate the ~4 lines).
- Do not hand-edit `openapi.yaml` / `frontend/src/api/schema.ts`; regenerate with `npm run api`.
- **Commits:** repo owner commits only on request. The commit steps below mark the intended boundaries, but hold actual commits until the owner approves the full diff.
- Prompt is used **literally** (no `{{}}` templating). Validate a max length of 64 KiB.

---

### Task 1: Domain field + validation

**Files:**
- Modify: `backend/internal/domain/projectconfig.go`
- Test: `backend/internal/domain/projectconfig_test.go`

**Interfaces:**
- Produces: `ProjectConfig.OrchestratorPrompt string` (json `orchestratorPrompt`); `Validate()` rejects > 64 KiB.

- [ ] **Step 1: Write the failing tests** (append to `projectconfig_test.go`)

```go
func TestProjectConfig_OrchestratorPromptRoundTrips(t *testing.T) {
	in := domain.ProjectConfig{OrchestratorPrompt: "## Orchestrator role\nbe nice"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"orchestratorPrompt":`) {
		t.Fatalf("marshaled config missing orchestratorPrompt: %s", b)
	}
	var out domain.ProjectConfig
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.OrchestratorPrompt != in.OrchestratorPrompt {
		t.Fatalf("round-trip = %q, want %q", out.OrchestratorPrompt, in.OrchestratorPrompt)
	}
	if (domain.ProjectConfig{OrchestratorPrompt: "x"}).IsZero() {
		t.Fatal("config with a prompt must not be IsZero")
	}
}

func TestProjectConfig_OrchestratorPromptTooLong(t *testing.T) {
	cfg := domain.ProjectConfig{OrchestratorPrompt: strings.Repeat("a", 64*1024+1)}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected validation error for over-long orchestratorPrompt")
	}
	ok := domain.ProjectConfig{OrchestratorPrompt: strings.Repeat("a", 1024)}
	if err := ok.Validate(); err != nil {
		t.Fatalf("64KiB-bound prompt should validate: %v", err)
	}
}
```

Ensure the test file imports `encoding/json` and `strings` (add if missing).

- [ ] **Step 2: Run, verify FAIL**

Run: `cd backend && go test ./internal/domain/ -run OrchestratorPrompt -v`
Expected: compile error / FAIL (field `OrchestratorPrompt` undefined).

- [ ] **Step 3: Add the field + validation** in `projectconfig.go`

Add to the `ProjectConfig` struct (after the `Reviewers` field):

```go
	// OrchestratorPrompt, when set, replaces the built-in orchestrator standing
	// instructions for this project's orchestrator sessions. The confidentiality
	// guard is still appended. Empty = built-in default. Used literally.
	OrchestratorPrompt string `json:"orchestratorPrompt,omitempty"`
```

Add near the other consts:

```go
// maxOrchestratorPromptBytes bounds the per-project orchestrator prompt so it
// stays well within process-arg limits when injected into an agent launch.
const maxOrchestratorPromptBytes = 64 * 1024
```

Add to `Validate()` (before `return nil`):

```go
	if n := len(c.OrchestratorPrompt); n > maxOrchestratorPromptBytes {
		return fmt.Errorf("orchestratorPrompt: %d bytes exceeds max %d", n, maxOrchestratorPromptBytes)
	}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd backend && go test ./internal/domain/ -run OrchestratorPrompt -v`
Expected: PASS.

- [ ] **Step 5: Commit boundary** (hold for owner approval)

```bash
git add backend/internal/domain/projectconfig.go backend/internal/domain/projectconfig_test.go
git commit -m "feat(config): add orchestratorPrompt to ProjectConfig"
```

---

### Task 2: Wire buildSystemPrompt to the configured prompt

**Files:**
- Modify: `backend/internal/session_manager/manager.go` (`buildSystemPrompt`, ~965-985)
- Test: `backend/internal/session_manager/manager_test.go`

**Interfaces:**
- Consumes: `ProjectConfig.OrchestratorPrompt` (Task 1), `Store.GetProject` (existing, `manager.go:79`).

- [ ] **Step 1: Write the failing tests** (append to `manager_test.go`)

```go
func TestBuildSystemPrompt_OrchestratorUsesConfiguredPrompt(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: domain.ProjectConfig{OrchestratorPrompt: "CUSTOM ORCHESTRATOR RULES"}}
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	sp, err := m.buildSystemPrompt(ctx, domain.KindOrchestrator, "mer")
	if err != nil {
		t.Fatalf("buildSystemPrompt: %v", err)
	}
	if !strings.Contains(sp, "CUSTOM ORCHESTRATOR RULES") {
		t.Fatalf("system prompt missing configured prompt:\n%s", sp)
	}
	if strings.Contains(sp, "You are the human-facing coordinator") {
		t.Fatalf("configured prompt must REPLACE the built-in role:\n%s", sp)
	}
	if !strings.Contains(sp, "Standing-instruction confidentiality") {
		t.Fatalf("guard must still be appended:\n%s", sp)
	}
}

func TestBuildSystemPrompt_OrchestratorFallsBackWhenUnset(t *testing.T) {
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer"} // no OrchestratorPrompt
	lookPath := func(string) (string, error) { return "/bin/true", nil }
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: &recordingAgent{}}, Workspace: &fakeWorkspace{}, Store: st, Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st}, LookPath: lookPath})

	sp, err := m.buildSystemPrompt(ctx, domain.KindOrchestrator, "mer")
	if err != nil {
		t.Fatalf("buildSystemPrompt: %v", err)
	}
	if !strings.Contains(sp, "You are the human-facing coordinator for project mer") {
		t.Fatalf("expected built-in coordinator prompt:\n%s", sp)
	}
}
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd backend && go test ./internal/session_manager/ -run BuildSystemPrompt_Orchestrator -v`
Expected: FAIL (`TestBuildSystemPrompt_OrchestratorUsesConfiguredPrompt` — built-in prompt still present / custom missing).

- [ ] **Step 3: Implement** — in `buildSystemPrompt`, replace the orchestrator case:

```go
	case domain.KindOrchestrator:
		base = orchestratorPrompt(projectID)
		// A per-project override replaces the built-in role prompt. Tolerate a
		// missing/unreadable project (keep the built-in) so prompt generation
		// never fails on a config lookup.
		if rec, ok, err := m.store.GetProject(ctx, string(projectID)); err == nil && ok {
			if custom := strings.TrimSpace(rec.Config.OrchestratorPrompt); custom != "" {
				base = custom
			}
		}
```

(`strings` is already imported in `manager.go`.)

- [ ] **Step 4: Run, verify PASS** (and no regressions in the package)

Run: `cd backend && go test ./internal/session_manager/ -v`
Expected: PASS, including existing `TestSystemPrompt_AppendsConfidentialityGuard` (orchestrator case has no project in store → falls back to built-in, guard still appended).

- [ ] **Step 5: Commit boundary** (hold)

```bash
git add backend/internal/session_manager/manager.go backend/internal/session_manager/manager_test.go
git commit -m "feat(config): use per-project orchestratorPrompt in buildSystemPrompt"
```

---

### Task 3: CLI flag `--orchestrator-prompt-file` + mirror field

**Files:**
- Modify: `backend/internal/cli/project.go` (mirror type `projectConfig`, `projectSetConfigOptions`, `buildProjectConfig`, `newProjectSetConfigCommand`, imports)
- Test: `backend/internal/cli/project_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `setConfigRequest.Config.OrchestratorPrompt` populated from the flag/file/stdin.

- [ ] **Step 1: Write the failing test** (append to `project_test.go`, matching the file's existing harness for `buildProjectConfig`)

```go
func TestBuildProjectConfig_OrchestratorPromptFromFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(p, []byte("## role\nhi"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := buildProjectConfig(projectSetConfigOptions{}, "## role\nhi")
	if err != nil {
		t.Fatalf("buildProjectConfig: %v", err)
	}
	if cfg.OrchestratorPrompt != "## role\nhi" {
		t.Fatalf("OrchestratorPrompt = %q", cfg.OrchestratorPrompt)
	}
	// prompt-only is enough to satisfy the "at least one field" check
}

func TestBuildProjectConfig_PromptWithConfigJSONConflicts(t *testing.T) {
	_, err := buildProjectConfig(projectSetConfigOptions{configJSON: `{"defaultBranch":"x"}`}, "some prompt")
	if err == nil {
		t.Fatal("expected error combining --orchestrator-prompt-file with --config-json")
	}
}
```

Ensure `project_test.go` imports `os` and `path/filepath`.

- [ ] **Step 2: Run, verify FAIL**

Run: `cd backend && go test ./internal/cli/ -run BuildProjectConfig -v`
Expected: FAIL (signature mismatch — `buildProjectConfig` takes one arg).

- [ ] **Step 3: Implement**

3a. Add the field to the CLI mirror `projectConfig` (after `Orchestrator`):

```go
	OrchestratorPrompt string `json:"orchestratorPrompt,omitempty"`
```

3b. Add to `projectSetConfigOptions`:

```go
	orchestratorPromptFile string
```

3c. Change `buildProjectConfig` signature and body:

```go
func buildProjectConfig(opts projectSetConfigOptions, orchestratorPrompt string) (projectConfig, error) {
	if opts.clear {
		if orchestratorPrompt != "" {
			return projectConfig{}, usageError{errors.New("--orchestrator-prompt-file cannot be combined with --clear")}
		}
		return projectConfig{}, nil
	}
	if opts.configJSON != "" {
		if orchestratorPrompt != "" {
			return projectConfig{}, usageError{errors.New("--orchestrator-prompt-file cannot be combined with --config-json")}
		}
		var cfg projectConfig
		if err := json.Unmarshal([]byte(opts.configJSON), &cfg); err != nil {
			return projectConfig{}, usageError{fmt.Errorf("--config-json is not a valid JSON object: %w", err)}
		}
		return cfg, nil
	}

	env, err := parseEnvPairs(opts.env)
	if err != nil {
		return projectConfig{}, err
	}
	cfg := projectConfig{
		DefaultBranch:      opts.defaultBranch,
		SessionPrefix:      opts.sessionPrefix,
		Env:                env,
		Symlinks:           opts.symlink,
		PostCreate:         opts.postCreate,
		AgentConfig:        agentConfig{Model: opts.model, Permissions: opts.permission},
		Worker:             roleOverride{Agent: opts.workerAgent},
		Orchestrator:       roleOverride{Agent: opts.orchestratorAgent},
		OrchestratorPrompt: orchestratorPrompt,
	}
	if reflect.DeepEqual(cfg, projectConfig{}) {
		return projectConfig{}, usageError{errors.New("usage: provide at least one config flag, --config-json, or --clear")}
	}
	return cfg, nil
}
```

3d. Add a reader helper (in `project.go`):

```go
// readOrchestratorPrompt resolves --orchestrator-prompt-file: "" -> no prompt,
// "-" -> read in, else read the file. (Mirrors review.go's path/stdin reader;
// kept local to avoid a drive-by refactor of review.go.)
func readOrchestratorPrompt(in io.Reader, path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", nil
	}
	var raw []byte
	var err error
	if path == "-" {
		raw, err = io.ReadAll(in)
	} else {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		return "", usageError{fmt.Errorf("read orchestrator prompt: %w", err)}
	}
	return string(raw), nil
}
```

3e. In `newProjectSetConfigCommand` RunE, resolve the prompt and pass it in:

```go
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			prompt, err := readOrchestratorPrompt(cmd.InOrStdin(), opts.orchestratorPromptFile)
			if err != nil {
				return err
			}
			config, err := buildProjectConfig(opts, prompt)
			if err != nil {
				return err
			}
			req := setConfigRequest{Config: config}
			// ... unchanged ...
```

3f. Register the flag (with the others):

```go
	f.StringVar(&opts.orchestratorPromptFile, "orchestrator-prompt-file", "", "Path to a file with the orchestrator system prompt, or - for stdin")
```

3g. Add `"io"` and `"os"` to the `project.go` import block.

- [ ] **Step 4: Run, verify PASS**

Run: `cd backend && go test ./internal/cli/ -v`
Expected: PASS (new tests + existing project tests; the single `buildProjectConfig` caller is updated).

- [ ] **Step 5: Commit boundary** (hold)

```bash
git add backend/internal/cli/project.go backend/internal/cli/project_test.go
git commit -m "feat(cli): add --orchestrator-prompt-file to project set-config"
```

---

### Task 4: Controller acceptance + regenerate API artifacts

**Files:**
- Test: `backend/internal/httpd/controllers/projects_test.go` (extend `TestProjectsAPI_RejectsUnknownConfigKeys` or add a sibling)
- Regenerate: `backend/internal/httpd/apispec/openapi.yaml`, `frontend/src/api/schema.ts`

- [ ] **Step 1: Add an acceptance assertion** — in `projects_test.go`, near the existing strict-decode PUTs to `/api/v1/projects/rej/config`, add:

```go
	// A known orchestratorPrompt key is accepted (regression guard for the
	// strict decoder once the field exists on ProjectConfig).
	_, status, _ = doRequest(t, srv, "PUT", "/api/v1/projects/rej/config", `{"config":{"orchestratorPrompt":"hi"}}`)
	if status != http.StatusOK {
		t.Fatalf("orchestratorPrompt should be accepted, got %d", status)
	}
```

- [ ] **Step 2: Run, verify PASS**

Run: `cd backend && go test ./internal/httpd/controllers/ -run RejectsUnknownConfigKeys -v`
Expected: PASS (field is known → 200).

- [ ] **Step 3: Regenerate the API spec + TS types**

Run: `npm run api`
Expected: `openapi.yaml` and `frontend/src/api/schema.ts` now include `orchestratorPrompt` on the `ProjectConfig` schema.

- [ ] **Step 4: Verify spec parity**

Run: `cd backend && go test ./internal/httpd/...`
Expected: PASS (spec drift / route-parity tests green).

- [ ] **Step 5: Commit boundary** (hold)

```bash
git add backend/internal/httpd/controllers/projects_test.go backend/internal/httpd/apispec/openapi.yaml frontend/src/api/schema.ts
git commit -m "feat(api): expose orchestratorPrompt on project config; regen spec"
```

---

### Task 5: Full verification

- [ ] **Step 1:** `cd backend && go build ./... && go vet ./...` → no errors.
- [ ] **Step 2:** `cd backend && go test ./...` → all PASS.
- [ ] **Step 3:** `cd backend && go test -race ./internal/session_manager/ ./internal/cli/ ./internal/domain/` → PASS.
- [ ] **Step 4:** `npm run frontend:typecheck` → PASS (schema.ts addition compiles).
- [ ] **Step 5:** Present the full diff to the owner and ask before committing.

## Self-Review

- **Spec coverage:** field (T1), Validate cap (T1), buildSystemPrompt replace+fallback (T2), CLI flag + mirror + replace-semantics note (T3), strict-decode acceptance + API regen (T4), verification (T5). All spec sections mapped.
- **Type consistency:** `OrchestratorPrompt` used identically in domain, CLI mirror, and tests; `buildProjectConfig(opts, prompt string)` — single caller updated in T3 step 3e.
- **Placeholders:** none — all steps carry concrete code/commands.
- **Out of scope (per spec):** no `workerPrompt`, no templating, no `project get` human-readable display change (field visible via `--json`).
