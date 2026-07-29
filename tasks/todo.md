# Migração Electron → Tauri — execução (plano: ~/.claude/plans/jazzy-hatching-seal.md)

Wave 1: [T1 scaffold src-tauri (M0), T2 `ao daemon ensure` Go (M1), T3 CORS tauri origins]
→ Wave 2: [T4 bridge-types + tauri-bridge.ts, T5 módulo daemon Rust, T6 comandos Rust settings/misc]
→ Wave 3: [T6 comandos Rust misc] + verificação cega T4/T5
→ Wave 4a: [T7 chrome janela (executando), T8 atalhos renderer (verificado: PASS)]
→ Wave 4b: [T9 painel browser (spike primeiro; isolado — conflita em lib.rs/tauri-bridge)]
→ Wave 5: [T10 updater] → Wave 6: [T11 CI/release] → Wave 7: [T12 cleanup Electron, só após validação manual]

Specs completas em tasks/specs/T4..T12. Handoff: um orquestrador novo precisa apenas de
tasks/todo.md + tasks/specs/* + o plano ~/.claude/plans/jazzy-hatching-seal.md.
Regras fixas: verificação cega (wave-verifier, sonnet mínimo) por tarefa; specs de
execução via spec-executor sonnet; nunca 2 tarefas editando o mesmo arquivo na mesma onda
(Cargo.toml/lib.rs são os pontos de conflito — deps pré-adicionadas pelo orquestrador).
Contrato ensure: {"port","pid","mode":"attached|spawned|takeover"}.

## Wave 1
- [x] T1 — scaffold `frontend/src-tauri` (sonnet) — verificado às cegas: PASS
- [x] T2 — `ao daemon ensure` (sonnet) — verificado às cegas: PASS (smoke spawn/attach real); literais de mode corrigidos p/ attached/spawned pelo orquestrador
- [x] T3 — `DefaultAllowedOrigins` += `tauri://localhost`, `http://tauri.localhost` (haiku) — go test config/httpd OK

## Wave 2
- [x] T4 — bridge-types + tauri-bridge.ts — verificado às cegas: PASS
- [x] T5 — daemon Rust — verificado às cegas: PASS (41 testes)
- [x] T6 — comandos Rust settings/misc/import-scan — verificado às cegas: PASS (76 testes) — M0–M2 completos

## Review
- T7: `moveToApplicationsFolder` (macOS "move app to /Applications" prompt) foi
  descartado deliberadamente — não portado para o Tauri shell. Decisão tomada
  na execução do spec T7 (window chrome), conforme instrução explícita do spec
  ("Do NOT implement moveToApplicationsFolder (decision: dropped)").
