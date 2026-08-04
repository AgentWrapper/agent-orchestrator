import { describe, expect, test } from "vitest";
import {
	cursorPositionForRects,
	PROJECT_AGENT_SCENES,
} from "./ProjectAgentsDemo.scenes";

describe("Feature 4 project-agent choreography", () => {
	test("clicks through existing project settings instead of project creation", () => {
		const clickTargets = PROJECT_AGENT_SCENES.filter((scene) => scene.click).map(
			(scene) => scene.target,
		);

		expect(clickTargets).toEqual([
			"project-actions",
			"project-settings",
			"worker-trigger",
			"worker-cursor",
			"orchestrator-trigger",
			"orchestrator-claude",
			"save",
		]);
		expect(PROJECT_AGENT_SCENES.some((scene) => scene.target === "create-project")).toBe(false);
	});

	test("keeps selected agents through the saved state", () => {
		const saved = PROJECT_AGENT_SCENES.find((scene) => scene.saveState === "saved");

		expect(saved).toMatchObject({
			view: "settings",
			worker: "cursor",
			orchestrator: "claude-code",
			target: "save",
		});
	});

	test("places the cursor tip at the measured target center", () => {
		const root = { left: 100, top: 40, width: 500, height: 300 };
		const target = { left: 200, top: 100, width: 40, height: 20 };

		expect(cursorPositionForRects(root, target)).toEqual({
			x: 24,
			y: 23.333333333333332,
		});
	});
});
