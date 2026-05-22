# Competitive Research — Agent Orchestration Tools

_Compiled: 2026-02-13_

## Overview

Research into 16+ projects that orchestrate AI coding agents. The goal: understand abstractions, architectures, and gaps to build the best, most extensible agent orchestrator.

---

## Tier 1: Direct Competitors (Multi-Agent Orchestrators)

### Gas Town (Steve Yegge)

- **GitHub**: https://github.com/steveyegge/gastown
- **Stack**: Go 1.23+ (~189K LOC), SQLite3, Git 2.25+, tmux 3.0+
- **Stars**: Growing rapidly (released Jan 2026)

**Architecture — MEOW Stack (Molecular Expression of Work):**

| Layer                         | What                     | How                                                                            |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| **Beads**                     | Atomic work units        | JSONL files tracked in Git. IDs like `gt-abc12`. Universal data/control plane. |
| **Epics**                     | Hierarchical collections | Organize beads into tree structures for parallel/sequential execution          |
| **Molecules**                 | Workflow graphs          | Sequenced beads with dependencies, gates, loops                                |
| **Protomolecules & Formulas** | Reusable templates       | TOML format workflow definitions                                               |

**Agent Roles (7 roles, 2 scopes):**

| Role         | Scope | Purpose                                                   |
| ------------ | ----- | --------------------------------------------------------- |
| **Mayor**    | Town  | Chief AI coordinator with full workspace context          |
| **Deacon**   | Town  | Health daemon running patrol loops                        |
| **Dogs**     | Town  | Maintenance helpers                                       |
| **Crew**     | Rig   | Named, persistent agents for sustained design/review work |
| **Polecats** | Rig   | Ephemeral "cattle" workers spawned for specific tasks     |
| **Refinery** | Rig   | Merge queue manager handling conflicts                    |
| **Witness**  | Rig   | Supervises polecats, unblocks stuck work                  |

**Other Abstractions:**

- **Town** — Workspace directory (`~/gt/`) housing all projects
- **Rigs** — Project containers wrapping git repositories
- **Hooks** — Git worktree-based persistent storage surviving crashes
- **Convoys** — Work-tracking bundles grouping multiple beads for an agent
- **GUPP** — Agents must execute work on their hooks; scheduling persists across restarts

**Runtime Backends:** claude, gemini, codex, cursor, auggie, amp (per-rig config)

**Communication/Isolation:**

- Git worktrees for filesystem isolation per agent
- Beads/Hooks for coordination (external state, not shared context windows)
- GUPP: deterministic handoffs through version control, not LLM-judged phase gates

**Strengths:** Most architecturally ambitious. Crash recovery via git-backed Beads. Role-based agent hierarchy. Multi-agent support.
**Weaknesses:** ~$100/hr token burn, auto-merged failing tests, agents causing unexpected deletions. Go-only ecosystem. No web dashboard. Optimized for autonomous, not human-in-the-loop.

---

### Par (Coplane)

- **GitHub**: https://github.com/coplane/par
- **Stack**: Python 3.12+
- **Closest to our current approach**

**Key Abstractions:**

- **Sessions**: Single-repo isolated branches via git worktrees + tmux sessions
- **Workspaces**: Multi-repo synchronized development contexts
- **Control Center**: Unified tmux session with windows for each context
- **Labels**: Globally unique, human-readable names

**Features:**

- `par start my-feature` — creates worktree + branch + tmux session
- `par send <label> "<command>"` — execute commands in specific sessions remotely
- `par send all "<command>"` — broadcast to all sessions
- `par control-center` — unified navigation
- `.par.yaml` — automatic worktree initialization (copy .env, install deps, etc.)
- IDE integration via auto-generated `.code-workspace` files

**Strengths:** Simple, clean CLI. Very similar spirit to our system. Global-first access.
**Weaknesses:** Single runtime (tmux only). No web dashboard. No plugin system. No PR/CI tracking. No agent abstraction.

---

### CAO — CLI Agent Orchestrator (AWS Labs)

- **GitHub**: https://github.com/awslabs/cli-agent-orchestrator
- **Stack**: Python, tmux, HTTP server (localhost:9889)

**Key Abstractions:**

- **Supervisor + Workers**: Hierarchical model with three coordination patterns:
  - **Handoff**: Synchronous task transfer
  - **Assign**: Asynchronous spawning with callback
  - **Send Message**: Direct communication to agent inboxes
- **Session Isolation**: Agents in separate tmux windows with unique `CAO_TERMINAL_ID`
- **Flows**: Cron-based scheduled agent execution

**Supported Agents:** Amazon Q CLI (default), Kiro CLI, Codex CLI, Claude Code

**Strengths:** Clean supervisor/worker hierarchy. AWS backing.
**Weaknesses:** AWS-centric. Limited ecosystem.

---

### ccswarm (nwiizo)

- **GitHub**: https://github.com/nwiizo/ccswarm
- **Stack**: Rust (2024 edition), ratatui TUI, Tokio async, OpenTelemetry

**Key Abstractions:**

- **ProactiveMaster**: Orchestration core with zero shared state (message-passing channels)
- **Specialized Agent Pools**: Frontend, Backend, DevOps, QA
- **Multi-Provider Layer**: Claude Code, Aider, OpenAI Codex, custom tools
- **Session-Persistent Manager**: Claims 93% token reduction

**Isolation:** Git worktrees per agent. Native PTY sessions (no tmux dependency).

**Strengths:** Rust performance. No tmux dependency. Good provider abstraction.
**Weaknesses:** Partially implemented (orchestrator loop WIP as of v0.4.0).

---

### agent-team (nekocode)

- **GitHub**: https://github.com/nekocode/agent-team
- **Stack**: Rust 92.8%, npm distribution

**Key Abstractions:**

- **Agent Client Protocol (ACP)**: Standardized interface across all agents
- **Process Isolation**: Each agent in its own process with UDS socket
- **Remote Access**: Interact with any agent from any terminal

**Supported Agents:** 20+: Gemini, Copilot, Claude, Goose, Cline, Blackbox, OpenHands, Qwen, Kimi, and more.

**Strengths:** Broadest agent support. Clean protocol.
**Weaknesses:** Thin orchestration. No lifecycle management. No PR/CI tracking.

---

### claude-flow (ruvnet)

- **GitHub**: https://github.com/ruvnet/claude-flow
- **Stack**: TypeScript, Node.js 20+, WebAssembly, SQLite, PostgreSQL
- **Claims**: 100K+ monthly active users, 84.8% SWE-Bench solve rate

**Key Abstractions:**

- **Swarm Topologies**: mesh, hierarchical, ring, star configurations
- **Queen-Led Hierarchies**: Strategic Queens (planning), Tactical Queens (execution), Adaptive Queens (optimization)
- **8 Worker Types**: researcher, coder, analyst, tester, architect, reviewer, optimizer, documenter
- **60+ Specialized Agents** across 8 categories
- **31+ MCP Tools** across 7 categories
- **Shared Memory**: LRU cache with SQLite persistence (WAL mode)
- **ReasoningBank**: Pattern storage with trajectory learning
- **Consensus Mechanisms**: Raft, Byzantine, Gossip, Weighted, Majority

**Extension System:**

- 17 integration hooks (pre-task, post-task, etc.)
- Custom workers (12 context-triggered background services)
- Plugin SDK with IPFS marketplace distribution
- Native MCP integration

**Strengths:** TypeScript. Feature-rich. MCP native.
**Weaknesses:** Claude-only. Overcomplicated. Questionable claims.

---

## Tier 2: Adjacent Tools (Single-Agent or Cloud-First)

### OpenHands (formerly OpenDevin)

- **GitHub**: https://github.com/OpenHands/OpenHands (67.8K stars)
- **Stack**: Python 75.5%, TypeScript/React 22.3%, Docker, Kubernetes

**Key Abstractions:**

- **Software Agent SDK**: Composable Python library
- **Runtime/Sandbox**: Docker-based sandboxed execution environments
- **Event Stream Architecture**: Event-driven communication between backend and frontend
- **ACI (Agent Computer Interface)**: Standardized tools for agent-computer interaction

**Runtime Backends:** Docker (default), Kubernetes, E2B (cloud)

**Deployment Options:** Local CLI, Desktop GUI, Cloud hosting, Enterprise K8s

**Strengths:** Most mature cloud story. Event-sourced architecture (enables replay/audit). 67K stars.
**Weaknesses:** Heavy (Docker required). Not optimized for human-in-the-loop. Single-task runs, not parallel session management.

---

### SWE-agent + SWE-ReX (Princeton NLP)

- **GitHub**: https://github.com/SWE-agent/SWE-agent + https://github.com/SWE-agent/SWE-ReX
- **Stack**: Python 94.6%

**Key Abstractions:**

- **SWEEnv**: Environment manager (thin wrapper around SWE-ReX)
- **Agent**: Configured via single YAML file
- **ACI (Agent-Computer Interface)**: Custom tools installed in container
- **Deployment**: Abstraction over execution targets

**Runtime Backends (SWE-ReX):**

- Local Docker containers
- Modal (serverless compute)
- AWS Fargate (container orchestration)
- AWS EC2 (remote machines)
- Daytona (WIP)

Agent code remains the same regardless of deployment target.

**Strengths:** Cleanest deployment abstraction. Research-backed. Massively parallel (30+ instances).
**Weaknesses:** Research-focused, not production orchestrator.

---

### Goose (Block/Square)

- **GitHub**: https://github.com/block/goose
- **Stack**: Rust 58.9%, TypeScript 33.0%, Go (temporal scheduler)

**Key Abstractions:**

- **Crate architecture**: goose (core), goose-cli, goose-server, goose-mcp, mcp-client, mcp-core
- **Sessions**: Stateful autonomous execution environments
- **Recipes**: Task automation workflows
- **Extensions**: MCP-based capability providers (1,700+ available)
- **Custom Distributions**: Preconfigured providers, extensions, and branding

**Strengths:** Rust core. MCP-native. 1,700+ extensions. Professional engineering.
**Weaknesses:** Single-agent tool. No multi-agent orchestration.

---

### Cline

- **GitHub**: https://github.com/cline/cline
- **Stack**: TypeScript, Node.js, esbuild

**Key Abstractions:**

- **Sequential Decision Loop**: Analysis → Planning → Execution → Monitoring → Iteration
- **Checkpoint System**: Workspace snapshots at each step for compare/restore
- **Context Attachments**: @file, @folder, @url, @problems

**Strengths:** Great human-in-the-loop UX. Checkpoint/restore. Multi-provider.
**Weaknesses:** VS Code only. Single-agent.

---

### Multi-Agent Coding System (Danau5tin)

- **GitHub**: https://github.com/Danau5tin/multi-agent-coding-system
- **Stack**: Python, LiteLLM/OpenRouter, Docker
- **Reached #13 on Stanford's TerminalBench**

**Key Abstractions:**

- **Orchestrator Agent**: Strategic coordinator; never touches code
- **Explorer Agent**: Read-only investigation specialist
- **Coder Agent**: Implementation specialist with write access
- **Context Store**: Persistent knowledge layer across interactions
- **Knowledge Artifacts**: Discrete, reusable context items

**Communication:** XML tags with YAML parameters for task creation/delegation.

**Key Innovation:** "Front-loading precision" — over-providing context vs. rapid iteration.

**Strengths:** Clean role separation. Context Store innovation.
**Weaknesses:** Small project. Not production-ready.

---

### CCPM (Automaze)

- **GitHub**: https://github.com/automazeio/ccpm
- **Stack**: Python, GitHub REST API, Claude Code

**Key Abstractions:**

- **5-Phase Workflow**: Brainstorm → Document → Plan → Decompose → Execute
- **GitHub Issues as Database**: Issues store specs, comments provide audit trail
- **Epic Worktrees**: Each epic spawns a dedicated worktree
- **Parallel Agent Execution**: Tasks marked `parallel: true` run concurrently

---

### AI-Agents-Orchestrator (hoangsonww)

- **GitHub**: https://github.com/hoangsonww/AI-Agents-Orchestrator
- **Stack**: Python (Flask + Socket.IO), Vue 3 + Vite, Docker/Kubernetes

**Key Abstractions:**

- **Workflow Presets**: Default (Codex→Gemini→Claude), Quick, Thorough, Review-Only, Document
- **AI Adapters**: Standardized interfaces per agent tool
- **Session Manager**: Context across workflow steps
- **Vue Dashboard**: Real-time Socket.IO with Monaco editor

---

### wshobson/agents

- **GitHub**: https://github.com/wshobson/agents
- **Stack**: Claude Code plugin ecosystem

**Key Abstractions:**

- **Plugins**: 73 plugins, 112 agents, 146 skills, 79 tools
- **Progressive Disclosure Skills**: 3-tier knowledge
- **16 Workflow Orchestrators**: review, debug, feature, fullstack, research, security, migration
- **4-Tier Model Strategy**: Opus (critical) → Inherit → Sonnet → Haiku
- **Conductor Plugin**: Context → Spec & Plan → Implement

---

## Runtime Backend Research

### Cloud Sandbox Platforms

| Platform            | Startup Time | Isolation            | API Style            | Cost        |
| ------------------- | ------------ | -------------------- | -------------------- | ----------- |
| **Docker (local)**  | ~1-5s        | Container namespace  | Docker CLI/API       | Free        |
| **E2B**             | ~200-400ms   | Firecracker microVMs | Python/JS SDK        | Pay-per-use |
| **Daytona**         | ~27-90ms     | OCI containers       | Python/TS SDK + REST | Open source |
| **Modal Sandboxes** | Sub-second   | gVisor containers    | Python SDK           | $0.03/hr    |
| **Fly.io Machines** | ~200ms-1s    | Firecracker microVMs | REST API             | $0.02/hr    |

### Agent-Sandbox Connection Patterns (per LangChain)

**Pattern 1: Agent IN Sandbox**

- Agent runs inside the container/VM
- Communicates outward via HTTP/WebSocket
- Pro: Direct filesystem access, mirrors local dev
- Con: API keys inside sandbox

**Pattern 2: Sandbox AS Tool**

- Agent runs on orchestrator/server
- Calls sandbox via SDK/API for code execution
- Pro: API keys secure, parallel execution
- Con: Network latency per call

### Communication Protocols

| Protocol             | Use Case                | Used By                          |
| -------------------- | ----------------------- | -------------------------------- |
| **REST API**         | Request/response        | OpenHands, Fly.io, Daytona       |
| **WebSocket**        | Bidirectional streaming | OpenHands, Claude Agent SDK      |
| **stdio/subprocess** | Child process           | Claude Agent SDK, Codex CLI, MCP |
| **tmux send-keys**   | Terminal injection      | Our orchestrator, Par, CAO       |
| **SSE**              | Server → client push    | MCP remote transport             |

### Heartbeat / Health Detection

| Pattern                  | Description                          | Used By                     |
| ------------------------ | ------------------------------------ | --------------------------- |
| **WebSocket ping/pong**  | Periodic heartbeats                  | OpenHands                   |
| **Process polling**      | Check PID alive                      | Claude Agent SDK            |
| **tmux capture-pane**    | Scrape terminal output               | Our `claude-session-status` |
| **File-based signaling** | Status to shared filesystem          | Our metadata files          |
| **HTTP health endpoint** | `/health` or `/status`               | OpenHands server            |
| **JSONL mtime**          | Check session file modification time | Our `claude-status`         |

---

## Key Findings & Gaps

### What Everyone Does

1. **Git worktrees** = standard isolation primitive
2. **tmux** = dominant session manager for local
3. **External state > context windows** (Beads, Context Store, GitHub Issues)
4. **MCP** = emerging extension protocol

### What Nobody Does Well (Our Opportunity)

1. **Multiple runtime backends** (tmux + Docker + cloud) with same interface
2. **Multiple agent support** with proper abstraction
3. **Human-in-the-loop optimization** (our core differentiator — everyone else optimizes for autonomous)
4. **Works out of the box** with zero setup
5. **Truly extensible plugin architecture** for all concerns
6. **Beautiful web dashboard** with real-time PR/CI/review tracking
7. **Full PR lifecycle management** (CI checks, review comments, merge readiness, auto-reactions)

### Best Ideas to Steal

- **Gas Town**: Git-backed state (Beads), role-based agents, crash recovery
- **OpenHands**: Event-sourced architecture, Docker/K8s runtime abstraction
- **SWE-ReX**: Clean deployment backend interface (`swe-rex[modal]`, `swe-rex[fargate]`)
- **Par**: Simple `.par.yaml` config, global labels, broadcast to all
- **Goose**: MCP-based extensions, Rust crate architecture
- **Cline**: Checkpoint/restore system
- **Multi-Agent Coder**: Context Store, front-loading precision
- **agent-team**: Agent Client Protocol for 20+ agents

---

## Sources

- [Gas Town](https://github.com/steveyegge/gastown)
- [Gas Town Architecture Analysis](https://reading.torqsoftware.com/notes/software/ai-ml/agentic-coding/2026-01-15-gas-town-multi-agent-orchestration-framework/)
- [Gas Town: Two Kinds of Multi-Agent](https://paddo.dev/blog/gastown-two-kinds-of-multi-agent/)
- [Par](https://github.com/coplane/par)
- [CAO](https://github.com/awslabs/cli-agent-orchestrator)
- [ccswarm](https://github.com/nwiizo/ccswarm)
- [agent-team](https://github.com/nekocode/agent-team)
- [claude-flow](https://github.com/ruvnet/claude-flow)
- [OpenHands](https://github.com/OpenHands/OpenHands)
- [SWE-agent](https://github.com/SWE-agent/SWE-agent)
- [SWE-ReX](https://github.com/SWE-agent/SWE-ReX)
- [Goose](https://github.com/block/goose)
- [Cline](https://github.com/cline/cline)
- [Multi-Agent Coding System](https://github.com/Danau5tin/multi-agent-coding-system)
- [CCPM](https://github.com/automazeio/ccpm)
- [AI-Agents-Orchestrator](https://github.com/hoangsonww/AI-Agents-Orchestrator)
- [wshobson/agents](https://github.com/wshobson/agents)
- [LangChain: Two Agent-Sandbox Patterns](https://blog.langchain.com/the-two-patterns-by-which-agents-connect-sandboxes/)
- [Modal: Top Code Sandbox Products](https://modal.com/blog/top-code-agent-sandbox-products)
- [Rise of Coding Agent Orchestrators](https://www.aviator.co/blog/the-rise-of-coding-agent-orchestrators/)
- [E2B](https://e2b.dev/)
- [Daytona](https://www.daytona.io/)
- [Fly.io AI](https://fly.io/ai)
