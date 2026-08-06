export type ConversationEvent = {
	seq: number;
	projectId: string;
	sessionId?: string;
	type: string;
	payload?: { conversationId?: string; [key: string]: unknown };
	createdAt: string;
};

/** Pull complete LF or CRLF SSE frames while preserving an incomplete tail. */
export function takeSseFrames(buffer: string): { frames: string[]; remainder: string } {
	const frames: string[] = [];
	let remainder = buffer;
	let boundary = /\r?\n\r?\n/.exec(remainder);
	while (boundary) {
		frames.push(remainder.slice(0, boundary.index));
		remainder = remainder.slice(boundary.index + boundary[0].length);
		boundary = /\r?\n\r?\n/.exec(remainder);
	}
	return { frames, remainder };
}

export function parseSseFrame(frame: string): ConversationEvent | undefined {
	let id = 0;
	const data: string[] = [];
	for (const raw of frame.replace(/\r/g, "").split("\n")) {
		if (raw.startsWith("id:")) id = Number(raw.slice(3).trim());
		else if (raw.startsWith("data:")) data.push(raw.slice(5).trimStart());
	}
	if (data.length === 0) return undefined;
	try {
		const event = JSON.parse(data.join("\n")) as ConversationEvent;
		if (!Number.isFinite(event.seq)) event.seq = id;
		return event;
	} catch {
		return undefined;
	}
}
