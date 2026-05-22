---
"@aoagents/ao-web": patch
"@aoagents/ao-plugin-agent-grok": patch
---

Fix the packaged dashboard startup crash caused by bundled agent-grok code reading `../package.json` from the publish host path. Agent-grok now generates manifest metadata before build/test/typecheck so the package version stays in sync without runtime package manifest resolution.
