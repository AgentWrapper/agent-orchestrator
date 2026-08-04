<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**병렬 AI 코딩 에이전트를 위한 오케스트레이션 계층**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

격리된 워크스페이스에서 병렬 AI 코딩 에이전트를 감독하는 Agentic IDE입니다. 완전한 제어와 CI 실패, 리뷰 코멘트, 머지 충돌로부터의 자동 피드백 루프를 제공합니다.

<img src="docs/assets/readme/dashboard.png" alt="병렬 코딩 에이전트 세션을 보여주는 Agent Orchestrator 대시보드" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

---

## Agent Orchestrator란?

Agent Orchestrator는 AI 코딩 에이전트를 병렬로 실행하기 위한 메타 하네스 에이전트 IDE입니다. Claude Code, Codex, Cursor, Kimi Code, opencode 등 터미널 기반 에이전트에 공유 워크스페이스를 제공하여 세션, 터미널, 브랜치, 풀 리퀘스트, 피드백 루프를 한곳에서 감독할 수 있습니다.

코딩은 여전히 에이전트가 수행합니다. AO는 그 주변 하네스를 제공합니다: 격리된 워크스페이스, 라이브 터미널 접근, 세션 상태, PR 인식, 그리고 CI 실패·리뷰 코멘트·머지 충돌을 올바른 에이전트로 자동 전달하는 루프입니다. 수많은 에이전트 터미널을 수동으로 조율하는 대신, AO는 병렬 에이전트 작업을 관리 가능한 워크플로로 바꿉니다.

## 왜 Agent Orchestrator인가?

AI 코딩 에이전트는 병렬로 일할 때 훨씬 더 유용해지지만, 병렬 작업은 금방 혼란스러워집니다. 브랜치가 겹치고, 터미널을 잃고, CI 실패를 추적해야 하며, 리뷰 코멘트에 답하고, 머지 충돌을 올바른 워커에게 전달해야 합니다.

Agent Orchestrator는 그 루프를 가시적이고 관리 가능하게 유지하도록 설계되었습니다. 다음과 같은 도움을 줍니다:

- 같은 프로젝트에서 여러 에이전트를 시작하되 작업을 섞지 않음
- 모든 세션을 별도의 git worktree에 유지
- 어떤 에이전트가 작업 중·대기 중·완료·차단 상태인지 확인
- CI 실패, 리뷰 코멘트, 머지 충돌을 올바른 세션으로 라우팅
- 공통 슈퍼바이저를 통해 서로 다른 에이전트 CLI 사용

## 작동 방식

높은 수준에서 Agent Orchestrator는 간단한 루프를 따릅니다:

1. 에이전트가 작업할 프로젝트를 추가합니다.
2. 데스크톱 앱 또는 CLI에서 하나 이상의 세션을 시작합니다.
3. AO가 각 세션에 대해 격리된 git worktree를 만듭니다.
4. AO가 해당 세션의 터미널 런타임에서 선택한 코딩 에이전트를 실행합니다.
5. 로컬 데몬이 세션 상태, 터미널 활동, 풀 리퀘스트, CI, 리뷰 피드백을 감시합니다.
6. 데스크톱 앱과 CLI가 현재 상태를 보여주고, 올바른 세션에 후속 지시를 보낼 수 있게 합니다.

결과는 에이전틱 코딩을 위한 로컬 제어 계층입니다. 코딩은 에이전트가 하고, Agent Orchestrator가 워크스페이스·상태·터미널·피드백 루프를 정리합니다.

## 기능

데스크톱 앱이 주요 제어 화면입니다: 왼쪽에 프로젝트, 중앙에 활성 세션, 인스펙터에 선택한 세션의 터미널·풀 리퀘스트 상태·리뷰 실행·브라우저 미리보기가 표시됩니다.

<table>
  <tr>
    <td width="36%">
      <h3>병렬 에이전트 세션</h3>
      <p>같은 프로젝트에서 여러 코딩 에이전트를 시작하면서 파일, 브랜치, 터미널, 풀 리퀘스트 상태를 섞지 않습니다.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="여러 병렬 세션을 보여주는 Agent Orchestrator 보드" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>라이브 터미널 제어</h3>
      <p>세션을 열어 워커 터미널에 연결하면서 세션 요약, PR 상태, 후속 작업을 계속 볼 수 있습니다.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Agent Orchestrator 내부의 세션 터미널" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>리뷰 피드백 루프</h3>
      <p>리뷰어 에이전트를 실행하고, 리뷰 상태를 확인하며, 요청된 변경 사항을 올바른 워커 세션으로 다시 라우팅합니다.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="리뷰 실행과 작업을 보여주는 Reviews 탭" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>인앱 브라우저 미리보기</h3>
      <p>터미널 옆에서 세션의 로컬 앱을 미리 보아 UI 작업, 브라우저 상태, 에이전트 출력을 함께 유지합니다.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="로컬 앱 미리보기를 보여주는 브라우저 미리보기 탭" />
    </td>
  </tr>
</table>

## 지원 에이전트

AO는 23개의 워커 에이전트 하네스 어댑터를 제공합니다:

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

리뷰어 에이전트는 별도로 구성됩니다. 현재 리뷰어 하네스는 다음과 같습니다:

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**터미널에서 실행되면 Agent Orchestrator에서도 실행됩니다.**

## 설치

플랫폼에 맞는 최신 데스크톱 빌드를 다운로드하세요:

| 플랫폼                  | 다운로드                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS (Apple silicon)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)           | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows                 | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)        | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)     | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

설치 후 Agent Orchestrator를 열고 AO가 관리할 저장소를 지정하세요. 데스크톱 앱이 데몬을 실행하므로 CLI는 필요하지 않습니다. 설치된 데스크톱 빌드는 실행 시와 실행 중 주기적으로 업데이트를 확인합니다. 에이전트 CLI 설정 및 문제 해결은 [설치 가이드](https://aoagents.dev/docs/installation)를 참고하세요.

<details>
<summary>npm으로 설치 (레거시 CLI, 더 이상 권장하지 않음)</summary>

npm은 여전히 동작하지만 더 이상 권장하지 않습니다. `0.10.0`이 npm에 게시된 최종 버전이며, `@aoagents/ao` 패키지는 동결되어 추가 업데이트를 받지 않습니다. PATH에 `ao` CLI가 있는 기존 사용자를 위해 유지됩니다. `ao start`는 위에 링크된 것과 동일한 데스크톱 빌드를 가져와 엽니다. 새 설치에서는 데스크톱 다운로드를 우선하세요.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## X에서 AO의 여정을 확인하세요

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Agent Orchestrator 여정 스크린샷 1" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Agent Orchestrator 여정 스크린샷 2" />
      </a>
    </td>
  </tr>
</table>

## 문서

| 문서                                                             | 다음이 필요할 때 여기서 시작                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | 백엔드 멘탈 모델, 라이프사이클, 영속성, CDC, 상태 도출, 데몬 경계.                           |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | 패키지 소유권과 각 백엔드 관심사가 속한 위치.                                                |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI 동작과 데몬 라우트 매핑.                                                                 |
| [docs/development.md](docs/development.md)                       | 로컬 개발을 위한 사전 요구 사항, 빌드 단계, 테스트 실행, 문제 해결.                          |
| [docs/STATUS.md](docs/STATUS.md)                                 | `main`에 현재 출시된 내용과 진행 중인 항목.                                                  |
| [docs/stack.md](docs/stack.md)                                   | 라이브러리, 런타임, 의존성 결정.                                                             |

## 텔레메트리

Agent Orchestrator의 Electron 렌더러는 안정성과 제품 이해를 위해 익명 사용 이벤트를 PostHog로 전송합니다. PostHog 세션 녹화는 기본적으로 비활성화되어 있습니다. 한시적 조사에서 활성화되면 로컬 경로와 로컬 URL은 전송 전에 마스킹됩니다. 전송을 끄려면 빌드 전에 `VITE_AO_POSTHOG_KEY`를 빈 문자열로 설정하세요. 자세한 내용은 [docs/telemetry.md](docs/telemetry.md)를 참고하세요.

## 라이선스

Apache License 2.0. [LICENSE](LICENSE)를 참고하세요.
