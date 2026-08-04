<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**La capa de orquestación para agentes de codificación con IA en paralelo**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Un IDE agéntico que supervisa agentes de codificación con IA en paralelo en espacios de trabajo aislados, con control total y bucles de feedback automáticos a partir de fallos de CI, comentarios de revisión y conflictos de fusión.

<img src="docs/assets/readme/dashboard.png" alt="Panel de Agent Orchestrator con sesiones paralelas de agentes de codificación" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

---

## ¿Qué es Agent Orchestrator?

Agent Orchestrator es un IDE de agentes tipo meta-harness para ejecutar agentes de codificación con IA en paralelo. Ofrece a agentes basados en terminal como Claude Code, Codex, Cursor, Kimi Code, opencode y otros un espacio de trabajo compartido donde sus sesiones, terminales, ramas, pull requests y bucles de feedback pueden supervisarse desde un solo lugar.

Los agentes siguen escribiendo el código. AO proporciona el harness a su alrededor: espacios de trabajo aislados, acceso en vivo al terminal, estado de sesión, conciencia de PR y bucles automáticos que devuelven fallos de CI, comentarios de revisión y conflictos de fusión al agente correcto. En lugar de coordinar manualmente un montón de terminales de agentes, AO convierte el trabajo paralelo de agentes en un flujo de trabajo gestionado.

## ¿Por qué Agent Orchestrator?

Los agentes de codificación con IA son mucho más útiles cuando pueden trabajar en paralelo, pero el trabajo paralelo se desordena rápido. Las ramas se solapan, se pierden terminales, los fallos de CI necesitan seguimiento, los comentarios de revisión requieren respuesta y los conflictos de fusión deben llegar al worker correcto.

Agent Orchestrator está pensado para mantener ese bucle visible y manejable. Te ayuda a:

- Iniciar varios agentes desde el mismo proyecto sin mezclar su trabajo
- Mantener cada sesión en un git worktree separado
- Ver qué agentes están trabajando, esperando, terminados o bloqueados
- Enrutar fallos de CI, comentarios de revisión y conflictos de fusión a la sesión correcta
- Usar distintos CLI de agentes a través de un supervisor común

## Cómo funciona

A alto nivel, Agent Orchestrator sigue un bucle sencillo:

1. Añade un proyecto en el que quieras que trabajen los agentes.
2. Inicia una o más sesiones desde la app de escritorio o la CLI.
3. AO crea un git worktree aislado para cada sesión.
4. AO lanza el agente de codificación seleccionado en el runtime de terminal de esa sesión.
5. El daemon local observa el estado de la sesión, la actividad del terminal, los pull requests, la CI y el feedback de revisión.
6. La app de escritorio y la CLI muestran el estado actual y te permiten enviar instrucciones de seguimiento a la sesión correcta.

El resultado es una capa de control local para la codificación agéntica: los agentes siguen codificando, mientras Agent Orchestrator organiza sus espacios de trabajo, estados, terminales y bucles de feedback.

## Funciones

La app de escritorio es la superficie de control principal: proyectos a la izquierda, sesiones activas en el centro e inspector con el terminal de la sesión seleccionada, estado del pull request, ejecuciones de revisión y vista previa del navegador.

<table>
  <tr>
    <td width="36%">
      <h3>Sesiones de agentes en paralelo</h3>
      <p>Inicia varios agentes de codificación desde el mismo proyecto sin mezclar archivos, ramas, terminales ni el estado de los pull requests.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Tablero de Agent Orchestrator con varias sesiones en paralelo" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Control de terminal en vivo</h3>
      <p>Abre cualquier sesión y conéctate al terminal del worker manteniendo a la vista el resumen de la sesión, el estado del PR y las acciones de seguimiento.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Terminal de sesión dentro de Agent Orchestrator" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Bucle de feedback de revisión</h3>
      <p>Ejecuta agentes revisores, inspecciona el estado de la revisión y enruta los cambios solicitados de vuelta a la sesión de worker correcta.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Pestaña Reviews con ejecuciones de revisores y acciones" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Vista previa del navegador en la app</h3>
      <p>Previsualiza la app local de una sesión junto al terminal para que el trabajo de UI, el estado del navegador y la salida del agente se mantengan juntos.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Pestaña de vista previa del navegador mostrando una app local" />
    </td>
  </tr>
</table>

## Agentes compatibles

AO incluye adaptadores para 23 harnesses de agentes worker:

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

Los agentes revisores se configuran por separado. Los harnesses de revisor actuales son:

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**Si se ejecuta en un terminal, se ejecuta en Agent Orchestrator.**

## Instalación

Descarga la última build de escritorio para tu plataforma:

| Plataforma            | Descarga                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)         | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)      | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

Tras instalar, abre Agent Orchestrator y apúntalo al repositorio que quieras que AO gestione. La app de escritorio ejecuta el daemon por ti, así que no se requiere CLI. Las builds de escritorio instaladas comprueban actualizaciones al iniciar y periódicamente mientras la app está en ejecución. Consulta la [guía de instalación](https://aoagents.dev/docs/installation) para la configuración de CLI de agentes y la resolución de problemas.

<details>
<summary>Instalar vía npm (CLI legacy, ya no recomendado)</summary>

npm sigue funcionando, pero ya no se recomienda. `0.10.0` es la versión final publicada en npm y el paquete `@aoagents/ao` está congelado y no recibirá más actualizaciones. Sigue disponible para usuarios existentes que tengan la CLI `ao` en su PATH; `ao start` descarga y abre la misma build de escritorio enlazada arriba. Para cualquier instalación nueva, prefiere la descarga de escritorio.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Sigue el recorrido de AO en X

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Captura uno del recorrido de Agent Orchestrator" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Captura dos del recorrido de Agent Orchestrator" />
      </a>
    </td>
  </tr>
</table>

## Documentación

| Documento                                                        | Empieza aquí cuando necesites                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | Modelo mental del backend, ciclo de vida, persistencia, CDC, derivación de estado y límites del daemon. |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Propiedad de paquetes y dónde pertenece cada preocupación del backend.                       |
| [docs/cli/README.md](docs/cli/README.md)                         | Comportamiento de la CLI y mapeo de rutas del daemon.                                        |
| [docs/development.md](docs/development.md)                       | Requisitos previos, pasos de build, ejecución de tests y resolución de problemas para desarrollo local. |
| [docs/STATUS.md](docs/STATUS.md)                                 | Qué se publica actualmente en `main` y qué sigue en curso.                                   |
| [docs/stack.md](docs/stack.md)                                   | Decisiones de bibliotecas, runtime y dependencias.                                           |

## Telemetría

El renderer de Electron de Agent Orchestrator envía eventos de uso anónimos a PostHog para fiabilidad y comprensión del producto. La grabación de sesiones de PostHog está desactivada por defecto; si una investigación temporal la habilita, las rutas locales y las URL locales se redactan antes de la transmisión. Establece `VITE_AO_POSTHOG_KEY` como cadena vacía antes de compilar para desactivar la transmisión. Consulta [docs/telemetry.md](docs/telemetry.md).

## Licencia

Apache License 2.0. Consulta [LICENSE](LICENSE).
