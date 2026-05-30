export async function readApiErrorMessage(response: Response): Promise<string> {
  if (response.status === 404) return "Session not found";

  const body = await response.text().catch(() => "");
  if (!body) return `HTTP ${response.status}`;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error.length > 0) return error;
    }
  } catch {
    // Fall back to the raw response body below.
  }

  return body;
}
