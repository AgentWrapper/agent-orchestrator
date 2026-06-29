package legacyimport

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	yaml "gopkg.in/yaml.v3"
)

// legacyConfig is the subset of the legacy global config.yaml the importer
// reads: the projects registry keyed by project id. Unknown top-level keys
// (notifiers, power, plugins, …) are intentionally ignored — they have no home
// in the rewrite schema (issue #247 §4).
type legacyConfig struct {
	Projects map[string]legacyProjectConfig `yaml:"projects"`
}

// legacyProjectConfig is one project's block. Only the fields the rewrite can
// represent are typed; the rest are captured as raw nodes purely so the importer
// can report them as dropped (issue #247 §4).
type legacyProjectConfig struct {
	Path string `yaml:"path"`
	Name string `yaml:"name"`
	// Repo is captured as a raw YAML node but never consumed; the origin URL is
	// re-resolved from the repo path at import time.
	Repo          *yaml.Node         `yaml:"repo"`
	DefaultBranch string             `yaml:"defaultBranch"`
	SessionPrefix string             `yaml:"sessionPrefix"`
	Env           map[string]string  `yaml:"env"`
	Symlinks      []string           `yaml:"symlinks"`
	PostCreate    []string           `yaml:"postCreate"`
	AgentConfig   *legacyAgentConfig `yaml:"agentConfig"`
	Worker        *legacyRole        `yaml:"worker"`
	Orchestrator  *legacyRole        `yaml:"orchestrator"`

	// Captured only to surface as dropped in the report (no rewrite home).
	Tracker          *yaml.Node `yaml:"tracker"`
	SCM              *yaml.Node `yaml:"scm"`
	AgentRules       *yaml.Node `yaml:"agentRules"`
	AgentRulesFile   *yaml.Node `yaml:"agentRulesFile"`
	OrchestratorRule *yaml.Node `yaml:"orchestratorRules"`
	Runtime          *yaml.Node `yaml:"runtime"`
	Workspace        *yaml.Node `yaml:"workspace"`
	Reactions        *yaml.Node `yaml:"reactions"`
}

type legacyAgentConfig struct {
	Model       string `yaml:"model"`
	Permissions string `yaml:"permissions"`
}

type legacyRole struct {
	Agent       string             `yaml:"agent"`
	AgentConfig *legacyAgentConfig `yaml:"agentConfig"`
}

// loadLegacyConfig reads and parses root/config.yaml. A missing file is not an
// error — it yields an empty registry so the caller reports "nothing to import".
func loadLegacyConfig(root string) (legacyConfig, error) {
	data, err := os.ReadFile(globalConfigPath(root))
	if os.IsNotExist(err) {
		return legacyConfig{}, nil
	}
	if err != nil {
		return legacyConfig{}, fmt.Errorf("read legacy config: %w", err)
	}
	var cfg legacyConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		var typeErr *yaml.TypeError
		if !errors.As(err, &typeErr) {
			return legacyConfig{}, fmt.Errorf("parse legacy config.yaml: %w", err)
		}
		// A type mismatch (e.g. a scalar where a mapping is expected) is a
		// partial decode: keep the decoded fields and continue.
	}
	return cfg, nil
}

// preferences is the portfolio/preferences.json overlay: only per-project
// display names survive into the rewrite (issue #247 §1).
type preferences struct {
	Projects map[string]struct {
		DisplayName string `json:"displayName"`
	} `json:"projects"`
}

func loadPreferences(root string) preferences {
	var p preferences
	data, err := os.ReadFile(preferencesPath(root))
	if err != nil {
		return p
	}
	_ = json.Unmarshal(data, &p) // best-effort overlay; a damaged file is ignored
	return p
}

// registeredManifest is the portfolio/registered.json overlay: it carries each
// project's addedAt, the best available registered_at provenance (issue #247 §1,
// G10). The legacy shape is a list of {id|path, addedAt} records.
type registeredManifest struct {
	Projects []struct {
		ID      string `json:"id"`
		Path    string `json:"path"`
		AddedAt string `json:"addedAt"`
	} `json:"projects"`
}

func loadRegistered(root string) registeredManifest {
	var m registeredManifest
	data, err := os.ReadFile(registeredPath(root))
	if err != nil {
		return m
	}
	_ = json.Unmarshal(data, &m)
	return m
}

// addedAt returns the registration timestamp for a project, matching first by
// id then by path. "" when the manifest has no record.
func (m registeredManifest) addedAt(id, path string) string {
	for _, p := range m.Projects {
		if p.ID == id && p.AddedAt != "" {
			return p.AddedAt
		}
	}
	for _, p := range m.Projects {
		if p.Path == path && p.AddedAt != "" {
			return p.AddedAt
		}
	}
	return ""
}
