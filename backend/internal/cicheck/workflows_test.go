package cicheck_test

import (
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
