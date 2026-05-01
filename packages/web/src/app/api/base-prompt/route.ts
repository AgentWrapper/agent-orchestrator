import { BASE_AGENT_PROMPT, PLANNING_ADDITION } from "@aoagents/ao-core";

/** GET /api/base-prompt — Return the default and planning base prompt text for the UI */
export async function GET() {
  return Response.json({
    text: BASE_AGENT_PROMPT,
    planningAddition: PLANNING_ADDITION,
  });
}
