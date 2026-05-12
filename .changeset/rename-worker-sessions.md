---
"@aoagents/ao-web": minor
---

Add inline rename for worker sessions in the sidebar. Each worker row now shows a small pencil button on hover; clicking it swaps the label for an input pre-filled with the current title. Enter persists via `PATCH /api/sessions/:id`, Escape cancels, and an empty value reverts the session to its default title. The rename is written to the existing `displayName` metadata field and is now the highest-priority signal in `getSessionTitle`, so a user-chosen label always beats PR/issue titles. The session ID (`ao-N`) remains the canonical identifier — only display surfaces change. (#1647)
