import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeSlackMessage } from "./ao-slack-notifier.mjs";

describe("ao Slack notifier message formatting", () => {
	it("mentions needs_input events when configured", () => {
		const msg = describeSlackMessage(
			{
				type: "needs_input",
				notification: {
					sessionId: "agent-1",
					projectId: "ao",
					message: "permission prompt",
				},
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🖐️ *needs_input* [ao] agent-1: permission prompt");
	});

	it("mentions ready_to_merge events when configured", () => {
		const msg = describeSlackMessage(
			{
				type: "ready_to_merge",
				notification: {
					sessionId: "agent-2",
					projectId: "ao",
					title: "PR ready",
					prUrl: "https://github.example/pr/1",
				},
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🟢 *ready_to_merge* [ao] agent-2: PR ready https://github.example/pr/1");
	});

	it("mentions park-shaped events when configured", () => {
		const msg = describeSlackMessage(
			{
				type: "queue_update",
				payload: {
					sessionId: "agent-3",
					projectId: "ao",
					message: "Parked awaiting operator decision",
				},
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 📌 *queue_update* [ao] agent-3: Parked awaiting operator decision");
	});

	it("does not mention pr_merged events", () => {
		const msg = describeSlackMessage(
			{
				type: "pr_merged",
				notification: {
					sessionId: "agent-4",
					projectId: "ao",
					title: "Merged after parked review",
				},
			},
			"U123",
		);

		assert.equal(msg, "🚀 *pr_merged* [ao] agent-4: Merged after parked review");
	});

	it("does not mention informational events even when they contain park text", () => {
		const msg = describeSlackMessage(
			{
				type: "info",
				notification: {
					sessionId: "agent-6",
					projectId: "ao",
					message: "worker parked and resumed",
				},
			},
			"U123",
		);

		assert.equal(msg, "📌 *info* [ao] agent-6: worker parked and resumed");
	});

	it("preserves existing text when no mention user is configured", () => {
		const msg = describeSlackMessage(
			{
				type: "needs_input",
				notification: {
					sessionId: "agent-5",
					projectId: "ao",
					message: "question",
				},
			},
			"",
		);

		assert.equal(msg, "🖐️ *needs_input* [ao] agent-5: question");
	});

	it("ignores informational events that are not park-shaped", () => {
		const msg = describeSlackMessage(
			{
				type: "info",
				notification: {
					sessionId: "agent-6",
					projectId: "ao",
					message: "heartbeat",
				},
			},
			"U123",
		);

		assert.equal(msg, null);
	});
});
