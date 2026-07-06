export interface RenderMarkdownRequest {
	filePath: string;
}

export interface RenderMarkdownResponse {
	url: string;
	title: string;
}

export interface MarkdownFileChangedEvent {
	filePath: string;
}

export const MARKDOWN_FILE_RE = /\.md$/i;
