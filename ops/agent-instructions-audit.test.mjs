import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const instructionFiles = [
	"agent-instructions/source/55-extensions.md",
	"AGENTS.md",
	"AGENTS.shared.md",
	"CLAUDE.md",
	"GEMINI.md",
];

async function readInstructionFile(path) {
	return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("agent instructions SDLC audit gate", () => {
	for (const file of instructionFiles) {
		it(`${file} requires durable lifecycle markers`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /SDLC audit markers/);
			assert.match(body, /Planning/);
			assert.match(body, /review\s+requested/);
			assert.match(body, /review\s+verdict/);
			assert.match(body, /CI\s+run/);
			assert.match(body, /final-review verdict/);
			assert.match(body, /PR comment/);
			assert.match(body, /review-passed/);
			assert.match(body, /ao activity/);
			assert.match(body, /\/api\/v1\/events/);
			assert.match(body, /Slack/);
		});

		it(`${file} blocks autonomous merge without a clean current-head final-review artifact`, async () => {
			const body = await readInstructionFile(file);

			assert.match(body, /Autonomous merge is blocked\s+unless/);
			assert.match(body, /current head SHA/);
			assert.match(body, /clean final-review verdict/);
			assert.match(body, /review-passed/);
		});
	}
});
