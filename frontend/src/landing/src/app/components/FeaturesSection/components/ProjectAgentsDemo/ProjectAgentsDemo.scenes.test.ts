import { describe, expect, test } from "vitest";
import {
	cursorPositionForRects,
	PROJECT_AGENT_SCENES,
	sceneClockKey,
} from "./ProjectAgentsDemo.scenes";

describe("Feature 4 project-agent choreography", () => {
	test("creates a new project through the compact real frontend flow", () => {
		const clickTargets = PROJECT_AGENT_SCENES.filter((scene) => scene.click).map(
			(scene) => scene.target,
		);

		expect(clickTargets).toEqual([
			"new-project",
			"project-kind",
			"worker-trigger",
			"worker-cursor",
			"orchestrator-trigger",
			"orchestrator-claude",
			"create-and-start",
		]);
	});

	test("keeps selected agents while creating the project", () => {
		const saving = PROJECT_AGENT_SCENES.find((scene) => scene.busy);

		expect(saving).toMatchObject({
			worker: "cursor",
			orch: "claude-code",
			target: "create-and-start",
		});
	});

	test("ends with the newly created project ready in the sidebar", () => {
		const created = PROJECT_AGENT_SCENES.find((scene) => scene.created);

		expect(created).toMatchObject({ target: "new-project-row", modal: false });
	});

	test("places the cursor tip at the measured target center", () => {
		const root = { left: 100, top: 40, width: 500, height: 300 };
		const target = { left: 200, top: 100, width: 40, height: 20 };

		expect(cursorPositionForRects(root, target)).toEqual({
			x: 24,
			y: 23.333333333333332,
		});
	});

	test("reschedules the clock when adjacent scenes share a duration", () => {
		const settingsClick = PROJECT_AGENT_SCENES.find((scene) => scene.id === "project-kind-click")!;
		const modalOpen = PROJECT_AGENT_SCENES.find((scene) => scene.id === "modal-open")!;

		expect(settingsClick.duration).toBe(modalOpen.duration);
		expect(sceneClockKey(settingsClick)).not.toBe(sceneClockKey(modalOpen));
	});
});
