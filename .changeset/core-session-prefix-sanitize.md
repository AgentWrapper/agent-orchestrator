---
"@aoagents/ao-core": patch
---

Harden session prefix generation by sanitizing inputs inside `generateSessionPrefix` via `sanitizeIdentifierComponent`, and derive prefixes from full paths via `deriveSessionPrefixFromProjectPath` when basenames collapse to the generic `project` fallback — covering global registry registration and local wrapped YAML. Legacy wrapped `storageKey` values append a short path fingerprint in that fallback case so distinct risky paths do not share the same storage directory key.
