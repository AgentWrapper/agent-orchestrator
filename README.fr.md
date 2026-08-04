<div align="center">
  <img src="assets/ao-logo.svg" alt="Agent Orchestrator" width="160" height="160" />

# Agent Orchestrator

**La couche d'orchestration pour les agents de codage IA en parallèle**

[![Stars](https://img.shields.io/github/stars/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/stargazers)
[![Contributors](https://img.shields.io/github/contributors/Untrivial-ai/agent-orchestrator)](https://github.com/Untrivial-ai/agent-orchestrator/graphs/contributors)
[![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?logo=twitter&logoColor=white)](https://x.com/aoagents)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/UZv7JjxbwG)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Un IDE agentique qui supervise des agents de codage IA en parallèle dans des espaces de travail isolés, avec un contrôle complet et des boucles de feedback automatiques à partir des échecs CI, des commentaires de revue et des conflits de fusion.

<img src="docs/assets/readme/dashboard.png" alt="Tableau de bord Agent Orchestrator montrant des sessions d'agents de codage en parallèle" width="100%" />
</div>

**Languages:** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

---

## Qu'est-ce qu'Agent Orchestrator ?

Agent Orchestrator est un IDE d'agents de type méta-harness pour exécuter des agents de codage IA en parallèle. Il offre aux agents basés sur le terminal comme Claude Code, Codex, Cursor, Kimi Code, opencode et d'autres un espace de travail partagé où leurs sessions, terminaux, branches, pull requests et boucles de feedback peuvent être supervisés depuis un seul endroit.

Les agents codent toujours. AO fournit le harness autour d'eux : espaces de travail isolés, accès live au terminal, état de session, conscience des PR, et boucles automatiques qui renvoient les échecs CI, commentaires de revue et conflits de fusion à l'agent concerné. Au lieu de coordonner manuellement une pile de terminaux d'agents, AO transforme le travail parallèle d'agents en un flux de travail géré.

## Pourquoi Agent Orchestrator ?

Les agents de codage IA sont bien plus utiles lorsqu'ils peuvent travailler en parallèle, mais le travail parallèle devient vite chaotique. Les branches se chevauchent, les terminaux se perdent, les échecs CI demandent un suivi, les commentaires de revue nécessitent une réponse, et les conflits de fusion doivent atteindre le bon worker.

Agent Orchestrator est conçu pour garder cette boucle visible et gérable. Il vous aide à :

- Lancer plusieurs agents depuis le même projet sans mélanger leur travail
- Garder chaque session dans un git worktree séparé
- Voir quels agents travaillent, attendent, ont terminé ou sont bloqués
- Router les échecs CI, commentaires de revue et conflits de fusion vers la bonne session
- Utiliser différents CLI d'agents via un superviseur commun

## Comment ça fonctionne

À haut niveau, Agent Orchestrator suit une boucle simple :

1. Ajoutez un projet sur lequel les agents doivent travailler.
2. Démarrez une ou plusieurs sessions depuis l'application de bureau ou la CLI.
3. AO crée un git worktree isolé pour chaque session.
4. AO lance l'agent de codage sélectionné dans le runtime terminal de cette session.
5. Le daemon local surveille l'état de session, l'activité du terminal, les pull requests, la CI et le feedback de revue.
6. L'application de bureau et la CLI affichent l'état actuel et vous permettent d'envoyer des instructions de suivi à la bonne session.

Le résultat est une couche de contrôle locale pour le codage agentique : les agents codent toujours, tandis qu'Agent Orchestrator organise leurs espaces de travail, statuts, terminaux et boucles de feedback.

## Fonctionnalités

L'application de bureau est la surface de contrôle principale : projets à gauche, sessions actives au centre, et dans l'inspecteur le terminal de la session sélectionnée, l'état du pull request, les exécutions de revue et l'aperçu navigateur.

<table>
  <tr>
    <td width="36%">
      <h3>Sessions d'agents en parallèle</h3>
      <p>Lancez plusieurs agents de codage depuis le même projet sans mélanger fichiers, branches, terminaux ni l'état des pull requests.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/dashboard.png" alt="Tableau Agent Orchestrator avec plusieurs sessions en parallèle" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Contrôle du terminal en direct</h3>
      <p>Ouvrez n'importe quelle session et attachez-vous au terminal du worker tout en gardant le résumé de session, l'état PR et les actions de suivi visibles.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/session-terminal.png" alt="Terminal de session dans Agent Orchestrator" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Boucle de feedback de revue</h3>
      <p>Exécutez des agents relecteurs, inspectez le statut de revue et renvoyez les changements demandés à la bonne session worker.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/reviews-tab.png" alt="Onglet Reviews montrant les exécutions de relecture et les actions" />
    </td>
  </tr>
  <tr>
    <td width="36%">
      <h3>Aperçu navigateur intégré</h3>
      <p>Prévisualisez l'application locale d'une session à côté du terminal pour garder ensemble le travail UI, l'état du navigateur et la sortie de l'agent.</p>
    </td>
    <td width="64%">
      <img src="docs/assets/readme/browser-preview.png" alt="Onglet d'aperçu navigateur montrant une application locale" />
    </td>
  </tr>
</table>

## Agents pris en charge

AO inclut des adaptateurs pour 23 harnesses d'agents worker :

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

Les agents relecteurs sont configurés séparément. Les harnesses de relecture actuels sont :

<p>
  <a href="https://aoagents.dev/docs/plugins/agents/claude-code"><img src="frontend/src/renderer/assets/agents/claude-code.svg" alt="" width="16" height="16" valign="middle" /> <code>claude-code</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/codex"><img src="frontend/src/renderer/assets/agents/codex.svg" alt="" width="16" height="16" valign="middle" /> <code>codex</code></a> ·
  <a href="https://aoagents.dev/docs/plugins/agents/opencode"><img src="frontend/src/renderer/assets/agents/opencode.svg" alt="" width="16" height="16" valign="middle" /> <code>opencode</code></a>
</p>

**S'il tourne dans un terminal, il tourne sur Agent Orchestrator.**

## Installation

Téléchargez la dernière build de bureau pour votre plateforme :

| Plateforme            | Téléchargement                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| macOS (Apple silicon) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip)   |
| macOS (Intel)         | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip)     |
| Windows               | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe)      |
| Linux (AppImage)      | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage) |
| Linux (Debian/Ubuntu) | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.deb)      |
| Linux (Fedora/RHEL)   | [Download](https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.rpm)      |

Après l'installation, ouvrez Agent Orchestrator et pointez-le vers le dépôt que vous voulez qu'AO gère. L'application de bureau lance le daemon pour vous, aucune CLI n'est requise. Les builds de bureau installées vérifient les mises à jour au lancement et périodiquement pendant l'exécution. Consultez le [guide d'installation](https://aoagents.dev/docs/installation) pour la configuration des CLI d'agents et le dépannage.

<details>
<summary>Installer via npm (CLI legacy, plus recommandé)</summary>

npm fonctionne encore mais n'est plus recommandé. `0.10.0` est la dernière version publiée sur npm, et le paquet `@aoagents/ao` est figé et ne recevra plus de mises à jour. Il reste disponible pour les utilisateurs existants qui ont la CLI `ao` dans leur PATH ; `ao start` récupère et ouvre la même build de bureau liée ci-dessus. Pour toute nouvelle installation, préférez le téléchargement de bureau.

```bash
npm install -g @aoagents/ao
ao start
```

</details>

## Suivez le parcours d'AO sur X

<table>
  <tr>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2026329204405723180">
        <img src="assets/tweet2.png" height="330" alt="Capture un du parcours d'Agent Orchestrator" />
      </a>
    </td>
    <td width="50%" align="center">
      <a href="https://x.com/agent_wrapper/status/2025986105485733945">
        <img src="assets/tweet1.png" height="330" alt="Capture deux du parcours d'Agent Orchestrator" />
      </a>
    </td>
  </tr>
</table>

## Documentation

| Document                                                         | Commencez ici lorsque vous avez besoin de                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                     | Modèle mental du backend, cycle de vie, persistance, CDC, dérivation du statut et limites du daemon. |
| [docs/backend-code-structure.md](docs/backend-code-structure.md) | Propriété des paquets et emplacement de chaque préoccupation backend.                        |
| [docs/cli/README.md](docs/cli/README.md)                         | Comportement de la CLI et correspondance des routes du daemon.                               |
| [docs/development.md](docs/development.md)                       | Prérequis, étapes de build, exécution des tests et dépannage pour le développement local.    |
| [docs/STATUS.md](docs/STATUS.md)                                 | Ce qui est actuellement livré sur `main` et ce qui est encore en cours.                      |
| [docs/stack.md](docs/stack.md)                                   | Décisions de bibliothèques, runtime et dépendances.                                          |

## Télémétrie

Le renderer Electron d'Agent Orchestrator envoie des événements d'usage anonymes à PostHog pour la fiabilité et la compréhension produit. L'enregistrement de session PostHog est désactivé par défaut ; si une investigation limitée dans le temps l'active, les chemins locaux et les URL locales sont expurgés avant transmission. Définissez `VITE_AO_POSTHOG_KEY` sur une chaîne vide avant la compilation pour désactiver la transmission. Voir [docs/telemetry.md](docs/telemetry.md).

## Licence

Apache License 2.0. Voir [LICENSE](LICENSE).
