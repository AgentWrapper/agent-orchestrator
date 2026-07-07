## Orchestrator role policy

Project-orchestrator standing policy is intentionally not inlined in the shared
repo instruction context. Only an ao-created orchestrator session whose injected
system prompt identifies it as the project orchestrator should read
`.claude/orchestrator-policy.md`. Workers and interactive/ad-hoc sessions ignore
that file.
