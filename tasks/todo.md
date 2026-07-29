# Migração Electron → Tauri — execução (plano: ~/.claude/plans/jazzy-hatching-seal.md)

Wave 1: [T1 scaffold src-tauri (M0), T2 `ao daemon ensure` Go (M1), T3 CORS tauri origins]
→ Wave 2: [T4 bridge-types + tauri-bridge.ts, T5 módulo daemon Rust, T6 comandos Rust settings/misc]
→ Wave 3: [T6 comandos Rust misc] + verificação cega T4/T5
→ Wave 4a: [T7 PASS (FAIL do verificador em preload/src/main era falso positivo — diffs do T4; arbitrado), T8 PASS]
   Checkpoint commit d6ab73e80 no branch tauri-migration (T1–T8).
→ Wave 4b: [T9 painel browser — tentativa 1 BLOCKED no spike (deadlock de main thread no
   próprio spike, diagnosticado e corrigido pelo orquestrador: ~50fps em release,
   commit a7b23fbdf); tentativa 2 DONE mas verificação opus reprovou com 7 achados
   (ACL brick, capture síncrono na main thread, mirror:// sem escopo, normalizer morto,
   teste vácuo, keylogging no forward, hang do canvasMirror); T9b corrigiu os 7,
   re-verificação opus: PASS; hardening extra do orquestrador (capability por webview
   label + is_browser_label no validate_caller). Checkpoint 39273ea68 (M4). Pendência
   Win/Linux: captura nativa stub até CI com runners nativos (T11).]
→ Wave 5: [T10 updater PASS + T10b fixes PASS — checkpoint 9e5eb41cb (M5)]
→ Wave 6: [T11 CI/release (executando)] → Wave 7: [T12 cleanup Electron, só após validação manual]
Pendências conhecidas p/ T11+: pubkey do updater em tauri.conf.json é placeholder (trocar
pela chave real de CI); captura Win/Linux é stub; teste negativo do wizard (dev esconde) ausente.

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
