export const ORCHESTRATOR_SPAWN_SOURCES = [
	"board",
	"restore_dialog",
	"topbar",
	"sidebar",
	"project_add",
	"settings",
	"restart",
	"command_palette",
	"launch_dialog",
] as const;

export type OrchestratorSpawnSource = (typeof ORCHESTRATOR_SPAWN_SOURCES)[number];
