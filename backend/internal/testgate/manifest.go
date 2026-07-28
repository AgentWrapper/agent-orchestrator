package testgate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Manifest is AO's Go-native model for .ao/testinfra.yml.
type Manifest struct {
	Build           CommandList            `yaml:"build,omitempty" json:"build,omitempty"`
	Run             CommandList            `yaml:"run,omitempty" json:"run,omitempty"`
	Ready           CommandList            `yaml:"ready,omitempty" json:"ready,omitempty"`
	Services        []ManifestService      `yaml:"services,omitempty" json:"services,omitempty"`
	Env             map[string]string      `yaml:"env,omitempty" json:"env,omitempty"`
	Tests           ManifestTests          `yaml:"tests,omitempty" json:"tests,omitempty"`
	JUnit           []string               `yaml:"junit,omitempty" json:"junit,omitempty"`
	TouchMap        map[string]CommandList `yaml:"touch_map,omitempty" json:"touchMap,omitempty"`
	Timeout         timeoutSpec            `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	TimeoutDuration time.Duration          `yaml:"-" json:"timeoutDuration,omitempty"`
	Hash            string                 `yaml:"-" json:"hash,omitempty"`
}

// ManifestTests groups test commands by selection class.
type ManifestTests struct {
	Own   CommandList `yaml:"own,omitempty" json:"own,omitempty"`
	Smoke CommandList `yaml:"smoke,omitempty" json:"smoke,omitempty"`
}

// ManifestService is one requested service in .ao/testinfra.yml.
type ManifestService struct {
	Type  string            `yaml:"type,omitempty" json:"type,omitempty"`
	Name  string            `yaml:"name,omitempty" json:"name,omitempty"`
	Image string            `yaml:"image,omitempty" json:"image,omitempty"`
	Env   map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
}

// CommandList accepts either a single shell command string or a YAML list.
type CommandList []string

// UnmarshalYAML accepts a command string or list of command strings.
func (c *CommandList) UnmarshalYAML(value *yaml.Node) error {
	switch value.Kind {
	case yaml.ScalarNode:
		var single string
		if err := value.Decode(&single); err != nil {
			return err
		}
		*c = commandListFromStrings([]string{single})
		return nil
	case yaml.SequenceNode:
		var list []string
		if err := value.Decode(&list); err != nil {
			return err
		}
		*c = commandListFromStrings(list)
		return nil
	default:
		return fmt.Errorf("expected command string or list")
	}
}

// UnmarshalYAML accepts a service name string or structured service object.
func (s *ManifestService) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		var serviceType string
		if err := value.Decode(&serviceType); err != nil {
			return err
		}
		serviceType = strings.TrimSpace(serviceType)
		*s = ManifestService{Type: serviceType, Name: serviceType}
		return nil
	}
	type serviceAlias ManifestService
	var service serviceAlias
	if err := value.Decode(&service); err != nil {
		return err
	}
	*s = ManifestService(service)
	s.Type = strings.TrimSpace(s.Type)
	s.Name = strings.TrimSpace(s.Name)
	if s.Name == "" {
		s.Name = s.Type
	}
	return nil
}

type timeoutSpec string

func (t *timeoutSpec) UnmarshalYAML(value *yaml.Node) error {
	switch value.Kind {
	case yaml.ScalarNode:
		*t = timeoutSpec(strings.TrimSpace(value.Value))
		return nil
	default:
		return fmt.Errorf("expected timeout string or seconds")
	}
}

// ParseManifest parses and validates .ao/testinfra.yml.
func ParseManifest(raw []byte) (Manifest, error) {
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var manifest Manifest
	if err := dec.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("testgate: decode manifest: %w", err)
	}
	if err := manifest.normalize(raw); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

// ParseManifestFile parses and validates a manifest from disk.
func ParseManifestFile(path string) (Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}, err
	}
	return ParseManifest(raw)
}

// ManifestHash returns a stable content hash for a manifest file.
func ManifestHash(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// ParseManifestTimeout parses timeout as a Go duration string or integer seconds.
func ParseManifestTimeout(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	if seconds, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if seconds < 0 {
			return 0, fmt.Errorf("testgate: timeout must be non-negative")
		}
		return time.Duration(seconds) * time.Second, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("testgate: invalid timeout %q", raw)
	}
	if d < 0 {
		return 0, fmt.Errorf("testgate: timeout must be non-negative")
	}
	return d, nil
}

func (m *Manifest) normalize(raw []byte) error {
	m.Build = commandListFromStrings(m.Build)
	m.Run = commandListFromStrings(m.Run)
	m.Ready = commandListFromStrings(m.Ready)
	m.Tests.Own = commandListFromStrings(m.Tests.Own)
	m.Tests.Smoke = commandListFromStrings(m.Tests.Smoke)
	m.JUnit = cleanStringList(m.JUnit)
	if len(m.Run) == 0 {
		return fmt.Errorf("testgate: manifest run command is required")
	}
	for pattern, commands := range m.TouchMap {
		cleaned := commandListFromStrings(commands)
		if len(cleaned) == 0 {
			delete(m.TouchMap, pattern)
			continue
		}
		m.TouchMap[pattern] = cleaned
	}
	for i := range m.Services {
		if m.Services[i].Type == "" {
			return fmt.Errorf("testgate: service %d missing type", i)
		}
	}
	timeout, err := ParseManifestTimeout(string(m.Timeout))
	if err != nil {
		return err
	}
	m.TimeoutDuration = timeout
	m.Hash = ManifestHash(raw)
	return nil
}

func commandListFromStrings(in []string) []string {
	out := make([]string, 0, len(in))
	for _, command := range in {
		command = strings.TrimSpace(command)
		if command != "" {
			out = append(out, command)
		}
	}
	return out
}

func cleanStringList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, value := range in {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}
