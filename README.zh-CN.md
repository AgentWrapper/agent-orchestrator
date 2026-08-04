<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**面向并行 AI 编程智能体的编排层**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

一款 Agentic IDE，可在隔离工作区中监督并行的 AI 编程智能体，提供完整控制，并自动处理来自 CI 失败、评审意见与合并冲突的反馈闭环。

<img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator 仪表盘，展示并行编程智能体会话" width="100%" />
</div>

**Languages:** [English](README.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

---

## 什么是 Agent Orchestrator？

Agent Orchestrator 是一款元级 harness 智能体 IDE，用于并行运行 AI 编程智能体。它为 Claude Code、Codex、Cursor、Kimi Code、opencode 等基于终端的智能体提供共享工作空间，可在一处监督会话、终端、分支、拉取请求与反馈闭环。

智能体仍然负责写代码。AO 在其外围提供 harness：隔离工作区、实时终端访问、会话状态、PR 感知，以及将 CI 失败、评审意见与合并冲突自动回传给对应智能体的循环。不必再手动协调一堆智能体终端，AO 把并行智能体工作变成可管理的工作流。

## 为什么选择 Agent Orchestrator？

当 AI 编程智能体可以并行工作时会更有用，但并行很快就会变得混乱：分支互相重叠、终端容易丢失、CI 失败需要跟进、评审意见需要回复、合并冲突也要送达正确的 worker。

Agent Orchestrator 就是为了让这条闭环始终可见、可控而构建的。它帮助你：

- 从同一项目启动多个智能体，且互不混杂工作
- 让每个会话运行在独立的 git worktree 中
- 查看哪些智能体正在工作、等待、完成或阻塞
- 将 CI 失败、评审意见与合并冲突路由回正确的会话
- 通过统一的 supervisor 使用不同的智能体 CLI

## 工作原理

从高层面看，Agent Orchestrator 遵循一个简单循环：

1. 添加希望智能体处理的项目。
2. 通过桌面应用或 CLI 启动一个或多个会话。
3. AO 为每个会话创建隔离的 git worktree。
4. AO 在该会话的终端运行时中启动所选编程智能体。
5. 本地 daemon 监视会话状态、终端活动、拉取请求、CI 与评审反馈。
6. 桌面应用与 CLI 展示当前状态，并允许你向正确的会话发送后续指令。

结果是一层面向智能体编程的本地控制层：智能体仍负责写代码，而 Agent Orchestrator 负责整理工作区、状态、终端与反馈闭环。

## 功能特性

桌面应用是主要控制界面：左侧是项目，中间是活动会话，检查器中展示所选会话的终端、拉取请求状态、评审运行与浏览器预览。

<table>
  <tr>
    <td width="36%">
      <h3>并行智能体会话</h3>
      <p>从同一项目启动多个编程智能体，而不混杂文件、分支、终端或拉取请求状态。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Agent Orchestrator 看板，展示多个并行会话" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>实时终端控制</h3>
      <p>打开任意会话并连接到 worker 终端，同时保持会话摘要、PR 状态与后续操作可见。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Agent Orchestrator 内的会话终端" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>评审反馈闭环</h3>
      <p>运行评审智能体，检查评审状态，并将请求的修改路由回正确的 worker 会话。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="显示评审运行与操作的 Reviews 标签页" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>应用内浏览器预览</h3>
      <p>在终端旁预览会话的本地应用，使 UI 工作、浏览器状态与智能体输出保持在一起。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="显示本地应用预览的浏览器预览标签页" />
    </td>
  </tr>
</table>

## 支持的智能体

AO 内置 23 种 worker 智能体 harness 适配器：

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/aider"><img src="frontend/src/renderer/assets/agents/aider.png" alt="" width="16" height="16" valign="middle" /> <code>aider</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/grok.png" alt="" width="16" height="16" valign="middle" /> <code>grok</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/droid.png" alt="" width="16" height="16" valign="middle" /> <code>droid</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/amp.svg" alt="" width="16" height="16" valign="middle" /> <code>amp</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/agy.png" alt="" width="16" height="16" valign="middle" /> <code>agy</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/crush.png" alt="" width="16" height="16" valign="middle" /> <code>crush</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/cursor"><img src="frontend/src/renderer/assets/agents/cursor.svg" alt="" width="16" height="16" valign="middle" /> <code>cursor</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/qwen.png" alt="" width="16" height="16" valign="middle" /> <code>qwen</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/copilot.svg" alt="" width="16" height="16" valign="middle" /> <code>copilot</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/goose.svg" alt="" width="16" height="16" valign="middle" /> <code>goose</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/auggie.svg" alt="" width="16" height="16" valign="middle" /> <code>auggie</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/continue.png" alt="" width="16" height="16" valign="middle" /> <code>continue</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/devin.png" alt="" width="16" height="16" valign="middle" /> <code>devin</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/cline.svg" alt="" width="16" height="16" valign="middle" /> <code>cline</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/kimi.png" alt="" width="16" height="16" valign="middle" /> <code>kimi</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/kiro.png" alt="" width="16" height="16" valign="middle" /> <code>kiro</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/kilocode.svg" alt="" width="16" height="16" valign="middle" /> <code>kilocode</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/vibe.png" alt="" width="16" height="16" valign="middle" /> <code>vibe</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/pi.png" alt="" width="16" height="16" valign="middle" /> <code>pi</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents"><img src="frontend/src/renderer/assets/agents/autohand.svg" alt="" width="16" height="16" valign="middle" /> <code>autohand</code></a>
</p>

评审智能体单独配置。当前评审 harness 为：

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**只要能在终端中运行，就能在 Agent Orchestrator 上运行。**

## 安装

下载适用于你平台的最新桌面构建：

| 平台                  | 下载                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS（Apple 芯片）   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS（Intel）        | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux（AppImage）     | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux（Debian/Ubuntu）| [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux（Fedora/RHEL）  | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

安装后，打开 Agent Orchestrator 并指向希望 AO 管理的仓库。桌面应用会为你运行 daemon，因此无需 CLI。已安装的桌面构建会在启动时以及运行期间定期检查更新。有关智能体 CLI 设置与故障排除，请参阅[安装指南](https://aoagents.dev/docs/installation)。

<details>
<summary>通过 npm 安装（旧版 CLI，不再推荐）</summary>

npm 仍然可用，但不再推荐。`0.10.0` 是发布到 npm 的最终版本，`@aoagents/ao` 包已冻结，不会再收到更新。它仍可供 PATH 上已有 `ao` CLI 的现有用户使用；`ao start` 会获取并打开上方链接的同一桌面构建。任何新安装请优先使用桌面下载。

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## 在 X 上见证 AO 的旅程

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Agent Orchestrator 旅程截图一" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Agent Orchestrator 旅程截图二" />
      </a>
    </td>
  </tr>
</table>

## 文档

| 文档                                                             | 在需要以下内容时从这里开始                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | 后端心智模型、生命周期、持久化、CDC、状态推导与 daemon 边界。                                |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | 包职责归属以及各后端关注点应放在何处。                                                       |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI 行为与 daemon 路由映射。                                                                 |
| [docs/development.md](docs/development.md)                       | 本地开发的先决条件、构建步骤、运行测试与故障排除。                                           |
| [docs/STATUS.md](docs/STATUS.md)                                 | `main` 上当前已交付的内容，以及仍在进行中的部分。                                            |
| [docs/stack.md](docs/stack.md)                                   | 库、运行时与依赖决策。                                                                       |

## 遥测

Agent Orchestrator 的 Electron 渲染进程会向 PostHog 发送匿名使用事件，用于可靠性与产品理解。PostHog 会话录制默认关闭；若在限时调查中启用，本地路径与本地 URL 会在传输前脱敏。构建前将 `VITE_AO_POSTHOG_KEY` 设为空字符串可禁用传输。详见 [docs/telemetry.md](docs/telemetry.md)。

## 许可证

Apache License 2.0。详见 [LICENSE](LICENSE)。
