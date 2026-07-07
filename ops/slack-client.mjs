// slack-client — thin wrapper over the Slack Web API + incoming-webhook sink
// used by the attention notifier. Kept dependency-light (global fetch) and
// injectable (pass a custom `fetchImpl` in tests). No workflow logic here.

export function createSlackClient({
	token = process.env.SLACK_BOT_TOKEN,
	channel = process.env.SLACK_CHANNEL,
	webhook = process.env.SLACK_WEBHOOK_URL,
	fetchImpl = globalThis.fetch,
} = {}) {
	const canApi = Boolean(token && channel);

	async function postMessage(text, { threadTs } = {}) {
		if (canApi) {
			const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({ channel, text, thread_ts: threadTs, unfurl_links: false }),
			});
			const j = await res.json();
			if (!j.ok) throw new Error(`slack chat.postMessage: ${j.error}`);
			return { ts: j.ts, channel: j.channel };
		}
		// Webhook fallback: no thread ts / message handle available.
		if (!webhook) throw new Error("no Slack sink configured");
		const res = await fetchImpl(webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text }),
		});
		// A webhook 429/5xx resolves the fetch; treat a non-2xx as a failure so
		// the caller can retry rather than marking the alert delivered.
		if (res && res.ok === false) {
			throw new Error(`slack webhook: HTTP ${res.status}`);
		}
		return { ts: null, channel: null };
	}

	// update edits a previously posted message in place (digest "edit in place").
	// Only possible with the Web API; webhook mode falls back to a fresh post.
	async function update(ts, text) {
		if (canApi && ts) {
			const res = await fetchImpl("https://slack.com/api/chat.update", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify({ channel, ts, text }),
			});
			const j = await res.json();
			if (!j.ok) throw new Error(`slack chat.update: ${j.error}`);
			return { ts: j.ts };
		}
		return postMessage(text);
	}

	return { postMessage, update, canApi };
}
