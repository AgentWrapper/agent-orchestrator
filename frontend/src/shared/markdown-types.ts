export type MarkdownSourceKind = "file" | "virtual" | "url";

export type MarkdownSource =
  | { kind: "file"; path: string }
  | { kind: "virtual"; content: string }
  | { kind: "url"; url: string };

export interface MarkdownDocument {
  id: string;
  sessionId: string;
  source: MarkdownSource;
  renderedHtml: string;
  title: string;
  error?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface RenderMarkdownRequest {
  sessionId: string;
  source: MarkdownSource;
}

export interface RenderMarkdownResponse {
  documentId: string;
  url: string;
  title: string;
  revision: number;
}

export interface MarkdownUpdateEvent {
  documentId: string;
  revision: number;
  needsReload: boolean;
  title?: string;
}

export const MarkdownIpcChannels = {
  fileChanged: "md:fileChanged",
  stateChanged: "md:stateChanged",
} as const;

export const MARKDOWN_FILE_RE = /\.md$/i;
