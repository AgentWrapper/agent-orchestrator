/**
 * Normalized chat timeline rows produced by the agent-stream reducer.
 *
 * Independent of any provider SDK and of the durable conversation snapshot
 * model. The reducer only needs these fields; the renderer maps them to AO UI.
 */

export type StreamMessageRole =
	| "user"
	| "assistant"
	| "thinking"
	| "tool_use"
	| "tool_result"
	| "system"
	| "error";

export interface StreamToolOutput {
	stream: "stdout" | "stderr";
	text: string;
}

export interface StreamMessage {
	role: StreamMessageRole;
	content: string;
	id?: string;
	timestamp?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	toolResult?: string;
	toolOutputs?: StreamToolOutput[];
	toolUseId?: string;
	/** Legacy process path id; treated as an alias of toolUseId for stream reduce. */
	toolCallId?: string;
	toolStatus?: string;
	isDelta?: boolean;
	isError?: boolean;
	isThinking?: boolean;
	streamItemId?: string;
	/** Legacy process path item id for assistant bubbles. */
	sourceItemId?: string;
	partial?: boolean;
}
