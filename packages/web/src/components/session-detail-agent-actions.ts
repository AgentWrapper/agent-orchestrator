import { cleanBugbotComment } from "./session-detail-utils";

const MAX_AGENT_MESSAGE_LENGTH = 9_500;
const MAX_TITLE_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 7_500;

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildAgentFixMessage(comment: { url: string; path: string; body: string }): string {
  const { title, description } = cleanBugbotComment(comment.body);
  const message = [
    "Please address this review comment:",
    "",
    `File: ${truncate(comment.path, 500)}`,
    `Comment: ${truncate(title, MAX_TITLE_LENGTH)}`,
    `Description: ${truncate(description, MAX_DESCRIPTION_LENGTH)}`,
    "",
    `Resolve the comment at ${comment.url} after fixing it.`,
  ].join("\n");

  return truncate(message, MAX_AGENT_MESSAGE_LENGTH);
}

export async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
  onSuccess: () => void,
  onError: () => void,
) {
  try {
    const message = buildAgentFixMessage(comment);
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    onSuccess();
  } catch (error) {
    console.error("Failed to send message to agent:", error);
    onError();
  }
}

export { buildAgentFixMessage };
