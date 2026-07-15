export type RuntimePreferenceSurface = "new-task" | "orchestrator-composer" | "suggestion-discussion";

export type RuntimePreferences = {
	customModel?: string;
	effortChoice?: string;
	modelChoice?: string;
	permissionChoice?: string;
};

const STORAGE_PREFIX = "ao.runtime-preferences.v1";

function storageKey(projectId: string, harness: string, surface: RuntimePreferenceSurface): string {
	return [STORAGE_PREFIX, surface, encodeURIComponent(projectId), encodeURIComponent(harness)].join(".");
}

function rendererStorage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

export function readRuntimePreferences(
	projectId: string,
	harness: string,
	surface: RuntimePreferenceSurface,
): RuntimePreferences {
	const storage = rendererStorage();
	if (!storage) return {};
	try {
		const raw = storage.getItem(storageKey(projectId, harness, surface));
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			...(typeof parsed.customModel === "string" ? { customModel: parsed.customModel } : {}),
			...(typeof parsed.effortChoice === "string" ? { effortChoice: parsed.effortChoice } : {}),
			...(typeof parsed.modelChoice === "string" ? { modelChoice: parsed.modelChoice } : {}),
			...(typeof parsed.permissionChoice === "string" ? { permissionChoice: parsed.permissionChoice } : {}),
		};
	} catch {
		return {};
	}
}

export function writeRuntimePreferences(
	projectId: string,
	harness: string,
	surface: RuntimePreferenceSurface,
	patch: RuntimePreferences,
): void {
	const storage = rendererStorage();
	if (!storage) return;
	try {
		const current = readRuntimePreferences(projectId, harness, surface);
		storage.setItem(storageKey(projectId, harness, surface), JSON.stringify({ ...current, ...patch }));
	} catch {
		// Preferences are convenience state. A disabled/full storage backend must
		// never prevent the user from creating or messaging a task.
	}
}
