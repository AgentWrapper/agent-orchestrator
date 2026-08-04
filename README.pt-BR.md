<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**A camada de orquestração para agentes de codificação com IA em paralelo**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Um IDE agentico que supervisiona agentes de codificação com IA em paralelo em workspaces isolados, com controle total e loops de feedback automáticos a partir de falhas de CI, comentários de review e conflitos de merge.

<img src="docs/assets/readme/dashboard.png" alt="Painel do Agent Orchestrator mostrando sessões paralelas de agentes de codificação" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português (Brasil)**

---

## O que é o Agent Orchestrator?

O Agent Orchestrator é um IDE de agentes do tipo meta-harness para executar agentes de codificação com IA em paralelo. Ele oferece a agentes baseados em terminal como Claude Code, Codex, Cursor, Kimi Code, opencode e outros um workspace compartilhado onde suas sessões, terminais, branches, pull requests e loops de feedback podem ser supervisionados de um só lugar.

Os agentes ainda fazem a codificação. O AO fornece o harness ao redor deles: workspaces isolados, acesso ao terminal em tempo real, estado da sessão, consciência de PR e loops automáticos que enviam falhas de CI, comentários de review e conflitos de merge de volta ao agente certo. Em vez de coordenar manualmente uma pilha de terminais de agentes, o AO transforma o trabalho paralelo de agentes em um fluxo de trabalho gerenciado.

## Por que o Agent Orchestrator?

Agentes de codificação com IA ficam bem mais úteis quando podem trabalhar em paralelo, mas o trabalho paralelo bagunça rápido. Branches se sobrepõem, terminais se perdem, falhas de CI precisam de acompanhamento, comentários de review precisam de resposta e conflitos de merge precisam chegar ao worker certo.

O Agent Orchestrator foi feito para manter esse loop visível e gerenciável. Ele ajuda você a:

- Iniciar vários agentes a partir do mesmo projeto sem misturar o trabalho deles
- Manter cada sessão em um git worktree separado
- Ver quais agentes estão trabalhando, aguardando, concluídos ou bloqueados
- Encaminhar falhas de CI, comentários de review e conflitos de merge para a sessão correta
- Usar diferentes CLIs de agentes por meio de um supervisor comum

## Como funciona

Em alto nível, o Agent Orchestrator segue um loop simples:

1. Adicione um projeto no qual os agentes devem trabalhar.
2. Inicie uma ou mais sessões pelo app desktop ou pela CLI.
3. O AO cria um git worktree isolado para cada sessão.
4. O AO inicia o agente de codificação selecionado no runtime de terminal dessa sessão.
5. O daemon local observa o estado da sessão, a atividade do terminal, pull requests, CI e feedback de review.
6. O app desktop e a CLI mostram o estado atual e permitem enviar instruções de acompanhamento à sessão correta.

O resultado é uma camada de controle local para codificação agentica: os agentes ainda codificam, enquanto o Agent Orchestrator organiza seus workspaces, status, terminais e loops de feedback.

## Recursos

O app desktop é a superfície de controle principal: projetos à esquerda, sessões ativas no centro e, no inspetor, o terminal da sessão selecionada, o estado do pull request, execuções de review e a prévia do navegador.

<table>
  <tr>
    <td width="36%">
      <h3>Sessões de agentes em paralelo</h3>
      <p>Inicie vários agentes de codificação a partir do mesmo projeto sem misturar arquivos, branches, terminais ou o estado dos pull requests.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Quadro do Agent Orchestrator com várias sessões em paralelo" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Controle de terminal ao vivo</h3>
      <p>Abra qualquer sessão e conecte-se ao terminal do worker mantendo o resumo da sessão, o estado do PR e as ações de acompanhamento à vista.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Terminal de sessão dentro do Agent Orchestrator" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Loop de feedback de review</h3>
      <p>Execute agentes revisores, inspecione o status da review e encaminhe as alterações solicitadas de volta à sessão de worker correta.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Aba Reviews mostrando execuções de revisores e ações" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Prévia do navegador no app</h3>
      <p>Pré-visualize o app local de uma sessão ao lado do terminal para manter juntos o trabalho de UI, o estado do navegador e a saída do agente.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Aba de prévia do navegador mostrando um app local" />
    </td>
  </tr>
</table>

## Agentes suportados

O AO inclui adaptadores para 23 harnesses de agentes worker:

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

Agentes revisores são configurados separadamente. Os harnesses de revisor atuais são:

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**Se roda em um terminal, roda no Agent Orchestrator.**

## Instalação

Baixe o build desktop mais recente para sua plataforma:

| Plataforma            | Download                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)         | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)      | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

Após instalar, abra o Agent Orchestrator e aponte-o para o repositório que você quer que o AO gerencie. O app desktop executa o daemon para você, então a CLI não é necessária. Builds desktop instalados verificam atualizações na inicialização e periodicamente enquanto o app está em execução. Veja o [guia de instalação](https://aoagents.dev/docs/installation) para configuração de CLIs de agentes e solução de problemas.

<details>
<summary>Instalar via npm (CLI legada, não mais recomendada)</summary>

O npm ainda funciona, mas não é mais recomendado. `0.10.0` é a versão final publicada no npm, e o pacote `@aoagents/ao` está congelado e não receberá mais atualizações. Ele permanece disponível para usuários existentes que têm a CLI `ao` no PATH; `ao start` busca e abre o mesmo build desktop linkado acima. Para qualquer configuração nova, prefira o download desktop.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Acompanhe a jornada do AO no X

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Captura um da jornada do Agent Orchestrator" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Captura dois da jornada do Agent Orchestrator" />
      </a>
    </td>
  </tr>
</table>

## Documentação

| Documento                                                        | Comece aqui quando precisar de                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | Modelo mental do backend, ciclo de vida, persistência, CDC, derivação de status e limites do daemon. |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Propriedade de pacotes e onde cada preocupação de backend deve ficar.                        |
| [docs/cli/README.md](docs/cli/README.md)                         | Comportamento da CLI e mapeamento de rotas do daemon.                                        |
| [docs/development.md](docs/development.md)                       | Pré-requisitos, etapas de build, execução de testes e solução de problemas para desenvolvimento local. |
| [docs/STATUS.md](docs/STATUS.md)                                 | O que atualmente é entregue em `main` e o que ainda está em andamento.                       |
| [docs/stack.md](docs/stack.md)                                   | Decisões de bibliotecas, runtime e dependências.                                             |

## Telemetria

O renderer Electron do Agent Orchestrator envia eventos de uso anônimos ao PostHog para confiabilidade e compreensão do produto. A gravação de sessão do PostHog fica desativada por padrão; se uma investigação com prazo limitado a ativar, caminhos locais e URLs locais são redigidos antes da transmissão. Defina `VITE_AO_POSTHOG_KEY` como string vazia antes do build para desativar a transmissão. Veja [docs/telemetry.md](docs/telemetry.md).

## Licença

Apache License 2.0. Veja [LICENSE](LICENSE).
