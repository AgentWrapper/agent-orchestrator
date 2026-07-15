package pipeline

import "fmt"

// TaskModeResolver reports the task modes an agent plugin supports. This is
// a narrow seam standing in for the old TypeScript PluginRegistry: the Go
// rewrite has no plugin registry yet, so a later task wires a real
// implementation (backed by the agent layer) into ValidateAgentModes.
//
// ok=false means the plugin is unknown (not registered at all), distinct
// from a plugin that is registered but supports no modes (empty modes,
// ok=true).
type TaskModeResolver interface {
	SupportedTaskModes(plugin string) (modes []TaskMode, ok bool)
}

// ValidateAgentModes validates that every agent-executor stage in p routes
// to a plugin resolver knows about, and that the plugin supports the
// stage's requested TaskMode. Non-agent stages (command, builtin) are
// ignored.
//
// Returns the first failure, mirroring the old TypeScript
// validatePipelineAgentModes, which threw PipelineConfigError on the first
// bad stage rather than collecting every failure (unlike config validation,
// which collects everything: this check runs after config load, against a
// resolver whose contents aren't known until runtime).
func ValidateAgentModes(p *Pipeline, resolver TaskModeResolver) error {
	for _, stage := range p.Stages {
		if stage.Executor.Kind != ExecutorAgent {
			continue
		}
		plugin := stage.Executor.Plugin
		mode := stage.Executor.Mode

		supported, ok := resolver.SupportedTaskModes(plugin)
		if !ok {
			return fmt.Errorf(
				"pipeline %q stage %q references unknown agent plugin %q",
				p.Name, stage.Name, plugin,
			)
		}
		if !containsMode(supported, mode) {
			return fmt.Errorf(
				"pipeline %q stage %q requires agent %q to support task mode %q, but its manifest declares supportedTaskModes=%v",
				p.Name, stage.Name, plugin, mode, supported,
			)
		}
	}
	return nil
}

func containsMode(modes []TaskMode, mode TaskMode) bool {
	for _, m := range modes {
		if m == mode {
			return true
		}
	}
	return false
}
