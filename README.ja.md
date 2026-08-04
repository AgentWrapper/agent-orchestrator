<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**並列 AI コーディングエージェントのためのオーケストレーション層**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

隔離されたワークスペースで並列 AI コーディングエージェントを監督する Agentic IDE。完全な制御と、CI 失敗・レビューコメント・マージコンフリクトからの自動フィードバックループを備えます。

<img src="docs/assets/readme/dashboard.png" alt="並列コーディングエージェントセッションを示す Agent Orchestrator ダッシュボード" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

---

## Agent Orchestrator とは？

Agent Orchestrator は、AI コーディングエージェントを並列実行するためのメタハーネス型エージェント IDE です。Claude Code、Codex、Cursor、Kimi Code、opencode などターミナルベースのエージェントに共有ワークスペースを提供し、セッション、ターミナル、ブランチ、プルリクエスト、フィードバックループを一箇所から監督できます。

コーディング自体はエージェントが行います。AO はその周囲のハーネスを提供します：隔離されたワークスペース、ライブターミナルアクセス、セッション状態、PR の把握、そして CI 失敗・レビューコメント・マージコンフリクトを適切なエージェントへ自動で戻すループです。エージェントのターミナル群を手作業で調整する代わりに、AO は並列エージェント作業を管理されたワークフローに変えます。

## なぜ Agent Orchestrator か？

AI コーディングエージェントは並列で動くとより有用になりますが、並列作業はすぐに混乱します。ブランチが重なり、ターミナルを見失い、CI 失敗のフォローアップ、レビューコメントへの返信、マージコンフリクトを正しいワーカーへ届ける必要が出てきます。

Agent Orchestrator は、そのループを可視化し管理しやすくするために作られています。次のことに役立ちます：

- 同じプロジェクトから複数のエージェントを起動し、作業を混ぜない
- 各セッションを別々の git worktree に保つ
- どのエージェントが作業中・待機中・完了・ブロック中かを把握する
- CI 失敗、レビューコメント、マージコンフリクトを正しいセッションへルーティングする
- 共通のスーパーバイザー経由で異なるエージェント CLI を使う

## 仕組み

高レベルでは、Agent Orchestrator はシンプルなループに従います：

1. エージェントに作業させたいプロジェクトを追加する。
2. デスクトップアプリまたは CLI から 1 つ以上のセッションを開始する。
3. AO が各セッション用に隔離された git worktree を作成する。
4. AO がそのセッションのターミナルランタイムで選択したコーディングエージェントを起動する。
5. ローカルデーモンがセッション状態、ターミナル活動、プルリクエスト、CI、レビューフィードバックを監視する。
6. デスクトップアプリと CLI が現在の状態を表示し、適切なセッションへフォローアップ指示を送れるようにする。

結果として、エージェンティックコーディング向けのローカル制御層が得られます。コーディングはエージェントが行い、Agent Orchestrator がワークスペース、ステータス、ターミナル、フィードバックループを整理します。

## 機能

デスクトップアプリが主な操作面です：左にプロジェクト、中央にアクティブなセッション、インスペクターに選択中セッションのターミナル、プルリクエスト状態、レビュー実行、ブラウザプレビューが表示されます。

<table>
  <tr>
    <td width="36%">
      <h3>並列エージェントセッション</h3>
      <p>同じプロジェクトから複数のコーディングエージェントを起動し、ファイル・ブランチ・ターミナル・プルリクエスト状態を混ぜません。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="複数の並列セッションを示す Agent Orchestrator ボード" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>ライブターミナル制御</h3>
      <p>任意のセッションを開きワーカーターミナルに接続しつつ、セッション要約、PR 状態、フォローアップ操作を視界に保ちます。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Agent Orchestrator 内のセッションターミナル" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>レビューフィードバックループ</h3>
      <p>レビュアーエージェントを実行し、レビュー状態を確認し、要求された変更を正しいワーカーセッションへ戻します。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="レビュー実行と操作を示す Reviews タブ" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>アプリ内ブラウザプレビュー</h3>
      <p>ターミナルの横でセッションのローカルアプリをプレビューし、UI 作業、ブラウザ状態、エージェント出力をまとめて保てます。</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="ローカルアプリのプレビューを示すブラウザプレビュータブ" />
    </td>
  </tr>
</table>

## 対応エージェント

AO は 23 のワーカーエージェントハーネス用アダプターを同梱しています：

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

レビュアーエージェントは別途設定します。現在のレビュアーハーネスは次のとおりです：

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**ターミナルで動くものは、Agent Orchestrator 上でも動きます。**

## インストール

お使いのプラットフォーム向けの最新デスクトップビルドをダウンロードしてください：

| プラットフォーム        | ダウンロード                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| macOS（Apple silicon）  | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS（Intel）          | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows                 | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux（AppImage）       | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux（Debian/Ubuntu）  | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux（Fedora/RHEL）    | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

インストール後、Agent Orchestrator を開き、AO に管理させたいリポジトリを指定します。デスクトップアプリがデーモンを起動するため、CLI は不要です。インストール済みのデスクトップビルドは起動時および実行中に定期的に更新を確認します。エージェント CLI のセットアップとトラブルシューティングは[インストールガイド](https://aoagents.dev/docs/installation)を参照してください。

<details>
<summary>npm 経由でインストール（レガシー CLI、非推奨）</summary>

npm はまだ動作しますが、もはや推奨されません。`0.10.0` が npm に公開された最終バージョンであり、`@aoagents/ao` パッケージは凍結され、今後の更新はありません。PATH に `ao` CLI がある既存ユーザー向けに利用可能です。`ao start` は上記と同じデスクトップビルドを取得して開きます。新規セットアップではデスクトップダウンロードを優先してください。

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## X で AO の歩みを見る

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Agent Orchestrator のジャーニー スクリーンショット 1" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Agent Orchestrator のジャーニー スクリーンショット 2" />
      </a>
    </td>
  </tr>
</table>

## ドキュメント

| ドキュメント                                                     | 次の内容が必要なときにここから                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | バックエンドのメンタルモデル、ライフサイクル、永続化、CDC、ステータス導出、デーモン境界。    |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | パッケージの所有権と、各バックエンド関心事の置き場所。                                       |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI の挙動とデーモンルートの対応。                                                           |
| [docs/development.md](docs/development.md)                       | ローカル開発の前提条件、ビルド手順、テスト実行、トラブルシューティング。                     |
| [docs/STATUS.md](docs/STATUS.md)                                 | `main` で現在出荷されている内容と、進行中の内容。                                            |
| [docs/stack.md](docs/stack.md)                                   | ライブラリ、ランタイム、依存関係の決定。                                                     |

## テレメトリ

Agent Orchestrator の Electron レンダラーは、信頼性と製品理解のため、匿名の利用イベントを PostHog に送信します。PostHog のセッション録画はデフォルトで無効です。期限付きの調査で有効にした場合、ローカルパスとローカル URL は送信前にマスキングされます。送信を無効にするには、ビルド前に `VITE_AO_POSTHOG_KEY` を空文字列に設定してください。詳細は [docs/telemetry.md](docs/telemetry.md) を参照してください。

## ライセンス

Apache License 2.0。詳細は [LICENSE](LICENSE) を参照してください。
