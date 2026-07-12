package cicheck_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	yaml "gopkg.in/yaml.v3"
)

var mainprotectRequiredChecks = []string{
	// These are the current mainprotect required status check contexts. The
	// audit assumes each required context is emitted by a stable workflow job ID.
	"api-drift",
	"boot-daemon-smoke",
	"build-test",
	"container",
	"format",
	"lint",
	"migration-version-guard",
	"review-passed",
	"scan",
}

func TestRequiredStatusCheckWorkflowsRunForMergeGroup(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	workflowsDir := filepath.Join(repoRoot, ".github", "workflows")
	entries, err := os.ReadDir(workflowsDir)
	if err != nil {
		t.Fatalf("read workflows dir: %v", err)
	}

	required := make(map[string]bool, len(mainprotectRequiredChecks))
	for _, check := range mainprotectRequiredChecks {
		required[check] = false
	}

	var missingMergeGroup []string
	var pathFilteredPullRequest []string
	for _, entry := range entries {
		if entry.IsDir() || !isWorkflowFile(entry.Name()) {
			continue
		}

		path := filepath.Join(workflowsDir, entry.Name())
		workflow := readWorkflow(t, path)
		on := workflowTriggers(workflow)
		hasMergeGroup := workflowHasMergeGroupTrigger(workflow)
		hasPathFilteredPullRequest := workflowHasPathFilteredPullRequest(on)
		for _, jobID := range workflowJobIDs(workflow) {
			if _, ok := required[jobID]; !ok {
				continue
			}
			required[jobID] = true
			if !hasMergeGroup {
				missingMergeGroup = append(missingMergeGroup, entry.Name()+":"+jobID)
			}
			if hasPathFilteredPullRequest {
				pathFilteredPullRequest = append(pathFilteredPullRequest, entry.Name()+":"+jobID)
			}
		}
	}

	var missingChecks []string
	for check, found := range required {
		if !found {
			missingChecks = append(missingChecks, check)
		}
	}
	sort.Strings(missingChecks)
	sort.Strings(missingMergeGroup)
	sort.Strings(pathFilteredPullRequest)

	if len(missingChecks) > 0 {
		t.Fatalf("required status checks are not produced by any workflow job: %s", strings.Join(missingChecks, ", "))
	}
	if len(missingMergeGroup) > 0 {
		t.Fatalf("required status check workflows lack merge_group trigger: %s", strings.Join(missingMergeGroup, ", "))
	}
	if len(pathFilteredPullRequest) > 0 {
		t.Fatalf("required status check workflows have path-filtered pull_request triggers: %s", strings.Join(pathFilteredPullRequest, ", "))
	}
}

func TestDocumentedBackendGateRunsRequiredLint(t *testing.T) {
	repoRoot := filepath.Clean(filepath.Join("..", "..", ".."))
	lintVersion := golangciLintVersion(t, filepath.Join(repoRoot, ".github", "workflows", "go.yml"))

	packageData, err := os.ReadFile(filepath.Join(repoRoot, "package.json"))
	if err != nil {
		t.Fatalf("read package.json: %v", err)
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(packageData, &pkg); err != nil {
		t.Fatalf("parse package.json: %v", err)
	}

	gate := pkg.Scripts["ci:backend"]
	if gate == "" {
		t.Fatalf("package.json scripts must define ci:backend for the documented backend pre-push gate")
	}
	for _, want := range append(
		workflowSingleLineRunCommands(t, filepath.Join(repoRoot, ".github", "workflows", "go.yml"), "build-test"),
		golangciLintModulePath(t, lintVersion),
		"run --path-mode=abs",
		"--allow-parallel-runners",
	) {
		if !strings.Contains(gate, want) {
			t.Fatalf("ci:backend = %q, want it to contain %q", gate, want)
		}
	}

	sourceInstructions := filepath.Join(repoRoot, "agent-instructions", "source", "55-extensions.md")
	instructions, err := os.ReadFile(sourceInstructions)
	if err != nil {
		t.Fatalf("read %s: %v", sourceInstructions, err)
	}
	if !strings.Contains(string(instructions), "`npm run ci:backend`") {
		t.Fatalf("%s must document npm run ci:backend as the backend build/test gate", sourceInstructions)
	}
	if !strings.Contains(string(instructions), "`npm run format:check`") {
		t.Fatalf("%s must document npm run format:check for local Prettier parity", sourceInstructions)
	}

	formatCheck := pkg.Scripts["format:check"]
	if formatCheck == "" {
		t.Fatalf("package.json scripts must define format:check for changed-file Prettier parity")
	}
	for _, want := range []string{"prettier@3", "--check", "--ignore-unknown"} {
		if !strings.Contains(formatCheck, want) {
			t.Fatalf("format:check = %q, want it to contain %q", formatCheck, want)
		}
	}
}

func golangciLintModulePath(t *testing.T, version string) string {
	t.Helper()
	if !strings.HasPrefix(version, "v") {
		t.Fatalf("golangci-lint action version must include a leading v, got %q", version)
	}
	major, _, _ := strings.Cut(version, ".")
	if major == "v" {
		t.Fatalf("golangci-lint action version must include a major version, got %q", version)
	}
	return "golangci/golangci-lint/" + major + "/cmd/golangci-lint@" + version
}

func workflowSingleLineRunCommands(t *testing.T, workflowPath, jobID string) []string {
	t.Helper()
	workflow := readWorkflow(t, workflowPath)
	jobs := mappingValue(documentMapping(workflow), "jobs")
	job := mappingValue(jobs, jobID)
	steps := mappingValue(job, "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode {
		t.Fatalf("%s job in %s must have steps", jobID, workflowPath)
	}

	var commands []string
	for _, step := range steps.Content {
		if step.Kind != yaml.MappingNode {
			continue
		}
		run := mappingValue(step, "run")
		if run == nil {
			continue
		}
		command := strings.TrimSpace(run.Value)
		if command == "" || strings.Contains(command, "\n") {
			continue
		}
		commands = append(commands, command)
	}
	if len(commands) == 0 {
		t.Fatalf("%s job in %s must have single-line run steps", jobID, workflowPath)
	}
	return commands
}

func isWorkflowFile(name string) bool {
	return strings.HasSuffix(name, ".yml") || strings.HasSuffix(name, ".yaml")
}

func readWorkflow(t *testing.T, path string) *yaml.Node {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var workflow yaml.Node
	if err := yaml.Unmarshal(data, &workflow); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return &workflow
}

func golangciLintVersion(t *testing.T, workflowPath string) string {
	t.Helper()
	workflow := readWorkflow(t, workflowPath)
	jobs := mappingValue(documentMapping(workflow), "jobs")
	lintJob := mappingValue(jobs, "lint")
	steps := mappingValue(lintJob, "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode {
		t.Fatalf("lint job in %s must have steps", workflowPath)
	}
	for _, step := range steps.Content {
		if step.Kind != yaml.MappingNode {
			continue
		}
		uses := mappingValue(step, "uses")
		if uses == nil || !strings.HasPrefix(uses.Value, "golangci/golangci-lint-action@") {
			continue
		}
		with := mappingValue(step, "with")
		version := mappingValue(with, "version")
		if version == nil || version.Value == "" {
			t.Fatalf("golangci-lint action in %s must pin with.version", workflowPath)
		}
		return version.Value
	}
	t.Fatalf("lint job in %s must use golangci/golangci-lint-action", workflowPath)
	return ""
}

func workflowHasMergeGroupTrigger(workflow *yaml.Node) bool {
	on := workflowTriggers(workflow)
	if on == nil || on.Kind != yaml.MappingNode {
		return false
	}
	return mappingValue(on, "merge_group") != nil
}

func workflowTriggers(workflow *yaml.Node) *yaml.Node {
	return mappingValue(documentMapping(workflow), "on")
}

func workflowHasPathFilteredPullRequest(on *yaml.Node) bool {
	if on == nil || on.Kind != yaml.MappingNode {
		return false
	}
	pullRequest := mappingValue(on, "pull_request")
	return mappingValue(pullRequest, "paths") != nil || mappingValue(pullRequest, "paths-ignore") != nil
}

func workflowJobIDs(workflow *yaml.Node) []string {
	jobs := mappingValue(documentMapping(workflow), "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode {
		return nil
	}
	ids := make([]string, 0, len(jobs.Content)/2)
	for i := 0; i < len(jobs.Content); i += 2 {
		ids = append(ids, jobs.Content[i].Value)
	}
	return ids
}

func documentMapping(node *yaml.Node) *yaml.Node {
	if node.Kind == yaml.DocumentNode && len(node.Content) > 0 {
		return node.Content[0]
	}
	return node
}

func mappingValue(mapping *yaml.Node, key string) *yaml.Node {
	if mapping == nil || mapping.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	return nil
}
