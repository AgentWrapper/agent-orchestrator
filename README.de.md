<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**Die Orchestrierungsschicht für parallele KI-Coding-Agenten**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Eine agentische IDE, die parallele KI-Coding-Agenten in isolierten Workspaces überwacht – mit voller Kontrolle und automatischen Feedback-Schleifen aus CI-Fehlern, Review-Kommentaren und Merge-Konflikten.

<img src="docs/assets/readme/dashboard.png" alt="Agent-Orchestrator-Dashboard mit parallelen Coding-Agenten-Sessions" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português (Brasil)](README.pt-BR.md)

---

## Was ist Agent Orchestrator?

Agent Orchestrator ist eine Meta-Harness-Agenten-IDE zum parallelen Ausführen von KI-Coding-Agenten. Sie gibt terminalbasierten Agenten wie Claude Code, Codex, Cursor, Kimi Code, opencode und anderen einen gemeinsamen Workspace, in dem Sessions, Terminals, Branches, Pull Requests und Feedback-Schleifen von einem Ort aus überwacht werden können.

Die Agenten schreiben weiterhin den Code. AO liefert das Harness darum herum: isolierte Workspaces, Live-Terminalzugriff, Session-Status, PR-Awareness und automatische Schleifen, die CI-Fehler, Review-Kommentare und Merge-Konflikte an den richtigen Agenten zurücksenden. Statt manuell einen Stapel Agenten-Terminals zu koordinieren, macht AO parallele Agentenarbeit zu einem verwalteten Workflow.

## Warum Agent Orchestrator?

KI-Coding-Agenten werden deutlich nützlicher, wenn sie parallel arbeiten können – parallele Arbeit wird aber schnell unübersichtlich. Branches überschneiden sich, Terminals gehen verloren, CI-Fehler brauchen Nacharbeit, Review-Kommentare brauchen Antworten, und Merge-Konflikte müssen den richtigen Worker erreichen.

Agent Orchestrator ist dafür gebaut, diese Schleife sichtbar und handhabbar zu halten. Es hilft dir:

- Mehrere Agenten aus demselben Projekt zu starten, ohne ihre Arbeit zu vermischen
- Jede Session in einem eigenen git-Worktree zu halten
- Zu sehen, welche Agenten arbeiten, warten, fertig oder blockiert sind
- CI-Fehler, Review-Kommentare und Merge-Konflikte an die richtige Session zu routen
- Verschiedene Agenten-CLIs über einen gemeinsamen Supervisor zu nutzen

## So funktioniert es

Auf hoher Ebene folgt Agent Orchestrator einer einfachen Schleife:

1. Füge ein Projekt hinzu, an dem Agenten arbeiten sollen.
2. Starte eine oder mehrere Sessions über die Desktop-App oder die CLI.
3. AO erstellt für jede Session einen isolierten git-Worktree.
4. AO startet den gewählten Coding-Agenten in der Terminal-Runtime dieser Session.
5. Der lokale Daemon überwacht Session-Status, Terminal-Aktivität, Pull Requests, CI und Review-Feedback.
6. Desktop-App und CLI zeigen den aktuellen Status und ermöglichen Follow-up-Anweisungen an die richtige Session.

Das Ergebnis ist eine lokale Steuerschicht für agentisches Coding: Die Agenten coden weiterhin, während Agent Orchestrator ihre Workspaces, Status, Terminals und Feedback-Schleifen organisiert.

## Funktionen

Die Desktop-App ist die zentrale Steueroberfläche: Projekte links, aktive Sessions in der Mitte und im Inspector Terminal der ausgewählten Session, Pull-Request-Status, Review-Läufe und Browser-Vorschau.

<table>
  <tr>
    <td width="36%">
      <h3>Parallele Agenten-Sessions</h3>
      <p>Starte mehrere Coding-Agenten aus demselben Projekt, ohne Dateien, Branches, Terminals oder Pull-Request-Status zu vermischen.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Agent-Orchestrator-Board mit mehreren parallelen Sessions" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Live-Terminal-Steuerung</h3>
      <p>Öffne jede Session und verbinde dich mit dem Worker-Terminal, während Session-Zusammenfassung, PR-Status und Follow-up-Aktionen im Blick bleiben.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Session-Terminal in Agent Orchestrator" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Review-Feedback-Schleife</h3>
      <p>Führe Reviewer-Agenten aus, prüfe den Review-Status und leite angeforderte Änderungen an die richtige Worker-Session zurück.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Reviews-Tab mit Reviewer-Läufen und Aktionen" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>In-App-Browser-Vorschau</h3>
      <p>Vorschau der lokalen App einer Session neben dem Terminal, damit UI-Arbeit, Browser-Status und Agenten-Ausgabe zusammenbleiben.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Browser-Vorschau-Tab mit lokaler App-Vorschau" />
    </td>
  </tr>
</table>

## Unterstützte Agenten

AO liefert Adapter für 23 Worker-Agenten-Harnesses:

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

Reviewer-Agenten werden separat konfiguriert. Die aktuellen Reviewer-Harnesses sind:

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**Wenn es im Terminal läuft, läuft es auf Agent Orchestrator.**

## Installation

Lade den neuesten Desktop-Build für deine Plattform herunter:

| Plattform             | Download                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)         | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)      | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

Nach der Installation öffne Agent Orchestrator und zeige auf das Repository, das AO verwalten soll. Die Desktop-App startet den Daemon für dich – eine CLI ist nicht erforderlich. Installierte Desktop-Builds prüfen beim Start und periodisch während der Laufzeit auf Updates. Siehe den [Installationsleitfaden](https://aoagents.dev/docs/installation) für die Einrichtung von Agenten-CLIs und Fehlerbehebung.

<details>
<summary>Installation über npm (Legacy-CLI, nicht mehr empfohlen)</summary>

npm funktioniert weiterhin, wird aber nicht mehr empfohlen. `0.10.0` ist die letzte auf npm veröffentlichte Version, und das Paket `@aoagents/ao` ist eingefroren und erhält keine weiteren Updates. Es bleibt für bestehende Nutzer verfügbar, die die `ao`-CLI im PATH haben; `ao start` holt und öffnet denselben Desktop-Build wie oben verlinkt. Für jede neue Einrichtung den Desktop-Download bevorzugen.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Begleite AOs Reise auf X

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Screenshot eins der Agent-Orchestrator-Reise" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Screenshot zwei der Agent-Orchestrator-Reise" />
      </a>
    </td>
  </tr>
</table>

## Dokumentation

| Dokument                                                         | Hier starten, wenn du brauchst                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | Backend-Mentalmodell, Lifecycle, Persistenz, CDC, Statusableitung und Daemon-Grenzen.        |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Package-Ownership und wo jedes Backend-Anliegen hingehört.                                   |
| [docs/cli/README.md](docs/cli/README.md)                         | CLI-Verhalten und Zuordnung der Daemon-Routen.                                               |
| [docs/development.md](docs/development.md)                       | Voraussetzungen, Build-Schritte, Tests ausführen und Fehlerbehebung für die lokale Entwicklung. |
| [docs/STATUS.md](docs/STATUS.md)                                 | Was derzeit auf `main` ausgeliefert wird und was noch in Arbeit ist.                         |
| [docs/stack.md](docs/stack.md)                                   | Entscheidungen zu Bibliotheken, Runtime und Abhängigkeiten.                                  |

## Telemetrie

Der Electron-Renderer von Agent Orchestrator sendet anonyme Nutzungsereignisse an PostHog für Zuverlässigkeit und Produktverständnis. Die PostHog-Session-Aufzeichnung ist standardmäßig deaktiviert; wenn eine zeitlich begrenzte Untersuchung sie aktiviert, werden lokale Pfade und lokale URLs vor der Übertragung redigiert. Setze `VITE_AO_POSTHOG_KEY` vor dem Build auf eine leere Zeichenkette, um die Übertragung zu deaktivieren. Siehe [docs/telemetry.md](docs/telemetry.md).

## Lizenz

Apache License 2.0. Siehe [LICENSE](LICENSE).
