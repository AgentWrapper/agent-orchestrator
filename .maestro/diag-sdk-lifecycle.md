# Диагностика: жизненный цикл SDK-сессии (runtime-sdk + session-manager)

Ветка: `feat/headless-multiproject` @ `4834c4ca`. Статус: РАЗВЕДКА (read-only), правок нет.
Цель: один корень → три симптома (end→resume луп; ложный stuck/probe_failure; падение `ao send` к занятому хосту).

---

## TL;DR — один корень

Движок **не различает три состояния SDK-хоста**: «жив и занят стримингом», «жив и доделал ход (здоровый IDLE)», «реально мёртв». Lifecycle-классификация и `ao send` опираются ТОЛЬКО на хрупкую сокет-пробу + грубую активити-пробу JSONL и **не используют ни PID, ни свежесть event-лога как сигнал жизни**. В результате:

1. Доделанный ход / простаивающий-живой хост со временем попадает в `runtime.state="exited"` → `isRestorable=true` → `ensureOrchestrator` авто-`restore()` БЕЗ промпта → пустой resume-хост ничего не делает и снова «умирает» → **самоподдерживающийся луп resumed↔end**.
2. Занятый или просто долго-простаивающий живой хост помечается `state=stuck, reason=probe_failure`.
3. `ao send` к занятому/живому оркестратору падает, потому что путь доставки сначала пробит liveness, а при неудаче пробы пытается `restore()`, который запрещён для НЕ-терминальной сессии.

Хост-сторона (`sdk-host.ts`) уже умеет всё нужное: `submitTurn` кладёт ход в **неограниченную FIFO-очередь** (`makePushableInput`) даже когда хост занят. Узкое место — предусловия на стороне движка, а не транспорт.

---

## Доказательства (живые логи на диске)

`~/.agent-orchestrator/runtime-sdk/<id>/events.ndjson` + `session.json`.

### aof-orchestrator — луп подтверждён
`session.json`: `epoch=7` (= 8 хост-процессов на одну сессию), `resumedFrom == sdkSessionId` (сессия резюмит саму себя), `hostPid=11405` (сейчас МЁРТВ — `ps -p 11405` пусто; луп заглох за ночь).

Lifecycle-события (seq, turn, type, subtype, ts):
```
0 0 session end       19:08:14   ← процесс стартует и сразу end (seq0), без init/result
0 0 session resumed   19:08:37
1 0 session end        19:22:52   ← resumed(seq0)→end(seq1): живёт ~14 мин, НИЧЕГО не делает
0 0 session resumed   19:22:55
2 1 session init       19:31:21   ← (через ~8 мин дожил, получил ход) init
5 1 session end        19:31:37
1 0 session resumed   19:31:40   ┐  плотный end→resumed→init за ~20 сек —
2 1 session init       19:31:40   ┘  это и есть «5 resumed подряд»
69 1 result success    19:32:51   ← реальная работа, 67 событий стрима
71 1 session end        19:46:03   ← ВАЖНО: end через ~14 МИН ПОСЛЕ result
0 0 session resumed   19:46:26
1 0 session end        19:54:47   ← resumed→end, опять вхолостую (~8 мин)
0 0 session resumed   19:54:49
1 0 session end        20:07:57
0 0 session resumed   22:42:51
1 0 session end        22:45:21
```

Выводы из лога:
- **Хост НЕ выходит сразу после `result`.** В сегменте с реальной работой `result`(seq69, 19:32:51) → `end`(seq71, 19:46:03) хост жил ~14 минут idle-живым. Значит `query()` со стриминговым входом корректно блокируется после хода (это опровергает гипотезу «хост умирает по result»). `end` приходит, когда хост **убивают извне** (движок) либо когда пустой resume-стрим завершается.
- **Пустой resume = вхолостую.** Сегменты `resumed(seq0) → end(seq1)` без `init`/`result` — это resume БЕЗ промпта: хост поднялся, поработал 0, был убит/завершился, и движок поднял следующий. Это и есть тело лупа.

### mae-123 (воркер) — мгновенный пустой end
`session.json`: `epoch=0`, `sdkSessionId=null`, `resumedFrom=null`. Весь `events.ndjson` = одна строка: `seq0 session end 18:14:08`. Хост стартовал и сразу завершился, ни одного `init`/`user` — `query()` не получил хода (промпт не доехал / хост убили на старте). Симптом «воркеры висят stuck/exited».

---

## 1. Где ставятся lifecycle-состояния и кто ставит stuck/probe_failure

**Канонические состояния** — `packages/core/src/lifecycle-state.ts:50-59`:
`not_started | working | idle | needs_input | stuck | detecting | done | terminated`.
**Причины** — `lifecycle-state.ts:60-79` (вкл. `probe_failure`, `runtime_lost`, `process_missing`, `error_in_process`).
**Runtime-состояния** — `lifecycle-state.ts:110`: `unknown | alive | exited | missing | probe_failed`.

Главный движок — поллер `determineStatus()` в `lifecycle-manager.ts`, интервал **30 с** (`lifecycle-manager.ts:3422-3430`, `cli/src/lib/lifecycle-service.ts:9,46`).

**`state=stuck, reason=probe_failure` ставится в 4 местах** (везде тернарник `idleWasBlocked ? "error_in_process" : "probe_failure"`):
- **A. Эскалация detecting** — `lifecycle-status-decisions.ts:158-165`. Сюда ведёт `resolveProbeDecision` при `runtimeProbe.failed || processProbe.failed` (`:299-310`): провал пробы → `detecting` → после порога → `stuck/probe_failure`.
- **B. Idle-beyond-threshold** — `lifecycle-manager.ts:1576-1588` (и для open-PR `lifecycle-status-decisions.ts:270-279`). Здоровая, но «слишком долго idle» сессия → `stuck/probe_failure`. **Это бьёт по оркестратору, который законно ждёт отчётов воркеров.**
- **C. Recovery-эскалация** — `recovery/actions.ts:106-117` и `:305-313` (превышен `maxRecoveryAttempts`). NB: в этом форке recovery **не имеет периодического вызывателя** (не импортируется из cli/web) — это on-demand путь `ao recover`.
- **D. ActivitySignal `probe_failure`** — когда `agent.getActivityState()` бросает (`lifecycle-manager.ts:1285`, `session-manager.ts:1335`) → сигнал `probe_failure` → путь A.

Порог эскалации в stuck — `lifecycle-status-decisions.ts:17-19`: `DETECTING_MAX_ATTEMPTS=3`, `DETECTING_MAX_DURATION_MS=5 мин`. Одной неудачной пробы НЕ хватает (есть дебаунс ~4 поллов / 5 мин).

Маппинг доделанного хода: **отдельного хендлера `result` НЕТ.** В `agent-claude-code/src/activity-detection.ts` (кейсы `tool_use`/`result` явно удалены, `:407-411`) завершённый ход определяется по возрасту последней JSONL-строки: `assistant`/`summary` → `ready` (свежо) → `idle` (старо) (`:424-431`). `exited` (процесс мёртв) → `lifecycle-manager.ts:1223-1227` ставит `runtime.state="exited"`.

## 2. Liveness-проба: кто зовёт и почему занятый хост → stuck

- Плагин `runtime-sdk/src/index.ts:155-169` `isAlive`: сперва `hostIsAlive(socket)` (сокет-`status`, таймаут **2 с**, `sdk-client.ts:98-113`), затем **PID-fallback** `process.kill(hostPid,0)` (`index.ts:159-166`, `EPERM`→жив).
- Зовёт периодически только поллер: `lifecycle-manager.ts:1124` `await runtime.isAlive(session.runtimeHandle)`.
- `isAlive===false` → `runtime.state="missing"/"process_missing"`, `runtimeProbe={state:"dead"}` (`:1131-1133`); `isAlive` **бросил** → `runtime.state="probe_failed"`, `runtimeProbe={state:"unknown", failed:true}` (`:1136-1139`) → путь A → (после дебаунса) stuck.
- **Свежесть event-лога НЕ учитывается нигде** — `eventLogPath` хранится в handle (`index.ts:39,129`), но никто не делает `stat`/mtime на `events.ndjson` в пробе. Единственный mtime — на JSON-метаданных сессии (`session-manager.ts:600,860,...`), не на event-логе.

**Почему занятый/тонкий хендл → stuck:**
1. Хост однопоточный: `status` обслуживается на том же event-loop, что и `host.consume(q)`; длинный синхронный всплеск (тяжёлый `translateSdkMessage` или **блокирующий `appendFileSync(eventLog,...)` под плотным стримом**, `sdk-host.ts:423`) может задержать ответ >2 с → `hostStatus`→`null` → сокет-проба `false`.
2. PID-fallback спасает ТОЛЬКО если в `handle.data.hostPid>0`. Если хендл «тонкий» (`{}`, напр. `prepareSession` `session-manager.ts:3187-3191`, или после resume не обновили PID в записи) — fallback пропускается (`index.ts:159`), и `isAlive` возвращает `false` чисто по сокет-таймауту.
3. Плюс путь B: здоровый-idle оркестратор за `agent-stuck.threshold` → `stuck` без всякой пробы.

## 3. Turn-end → lifecycle + источник лупа resume

- Движок **не парсит** события рантайма `{type:"session",subtype:"end"|"resumed"}` и `{type:"result"}` — в `packages/core/src` нет ни одной ссылки на них. Lifecycle строится только на грубых пробах: `runtime.getOutput()` (`lifecycle-manager.ts:1174,1240`), `agent.getActivityState()`/`isProcessRunning()` (`:1193,1256`).
- Хост-сторона (`sdk-host.ts`): `consume()` крутит `for await (msg of query)`, в `finally` зовёт `end()` → событие `session/end` + закрытие входа (`:304-318`); standalone затем `shutdown()`→`process.exit(0)` (`:489,513-514`). По логам это срабатывает либо при внешнем убийстве, либо при завершении пустого resume-стрима, а НЕ сразу по `result`.

**Самоподдерживающийся луп (подтверждён кодом + логом):**
1. Хост-процесс умирает (внешнее убийство движком / завершение пустого resume).
2. Следующий полл: активити=`exited` → `runtime.state="exited"` (`lifecycle-manager.ts:1223-1227`).
3. `isTerminalSession` → true по `runtime.state==="exited"` (`types.ts:249-256`); `isRestorable` = `isTerminalSession && !NON_RESTORABLE` , а `NON_RESTORABLE_STATUSES` **пустое** (`types.ts:241`) ⇒ `isRestorable=true`.
4. `ensureOrchestratorInternal:2317`: `if (isRestorable(existing)) return restore(sessionId)`. Гард на терминальность (`:2311`) ловит только `session.state==="done"`, а у нас `runtime.state="exited"` → проскакивает.
5. `restore()` ставит `AO_SDK_RESUME` из сохранённого `claudeSessionUuid` (`session-manager.ts:3792-3799`) и пересоздаёт рантайм (`:3775`), но **НЕ передаёт промпт** (`agentLaunchConfig` в `:3726-3735` имеет только `systemPromptFile`, нет `prompt` ⇒ `getEnvironment` не ставит `AO_SDK_INITIAL_PROMPT`, `agent-claude-code/index.ts:1131-1133`).
6. Resume-хост без хода ничего не делает → idle/умирает → GOTO 1. Луп. (`epoch=7` на aof.)

Кто триггерит `ensureOrchestrator` многократно: `cli/src/lib/headless-supervisor.ts:169` (`ao daemon --orchestrate-all`), `cli/src/commands/start.ts:942,1383`, и нативный фронт (Maestro) по требованию.

Оркестратор vs воркер: специального «keep-alive после хода» нет. Воркеры стартуют с промптом (задачей), после хода хост умирает → `exited`, авто-resume их не трогает (только оркестраторы идут через `ensureOrchestrator/restore`) → висят terminal/`stuck` (idle-beyond-threshold, путь B). Оркестраторы (`lifecycle.session.kind==="orchestrator"`, `lifecycle-manager.ts:1555`) — единственные, кого `restore` воскрешает, и из-за promptless-resume они лупятся.

## 4. Send-path: где проверка состояния и почему отказ

Цепочка: `cli/src/commands/send.ts:114,196-205` (делегирует в `sessionManager.send`, минуя tmux-idle-wait) → `session-manager.ts:2998` `send` → `prepareSession` (`:3179`) → `sendWithConfirmation` (`:3226`) → `runtimePlugin.sendMessage` (`:3242`) → `index.ts:147` → `hostSend` (`sdk-client.ts:41`) → хост `case "send"` → `submitTurn` → `input.push` (`sdk-host.ts:202-211,522-523`).

Проверка состояния — в `prepareSession`:
- `:3194` `if (forceRestore || isRestorable(normalized)) return restoreForDelivery(...)`.
- `:3203-3204` проба: `runtimePlugin.isAlive(handle).catch(() => true)` (бросок пробы → терпимо=жив), но **возврат `false`** (сокет-таймаут + нет/устарел `hostPid` в тонком хендле `:3187-3191`) → `:3216-3220` `restoreForDelivery("runtime is not alive")`.
- `restoreForDelivery` → `restore(sessionId)` (`:3147-3154`), а `restore` бросает на НЕ-терминальной сессии: `:3554-3572` `if (!isRestorable(session)) throw SessionNotRestorableError(... "session is not in a terminal state (status, activity)")`. (Строки `"channel is down"` в коде нет — это парафраз этого throw.)

Итого отказ — это **(b) false-negative liveness-пробы по занятому/тонко-хендлнутому хосту**, который ведёт в `restore()`, запрещённый для живой (не-терминальной) сессии. Отдельного правила «отклонить, потому что занят» нет.

**Mailbox/очереди на стороне движка НЕТ** (grep `mailbox|outbox|inbox|enqueue|deferredSend|messageQueue` по core/cli — пусто). Цель должна быть доступна и в правильном состоянии в момент send.

Но **хост уже реализует mailbox**: `submitTurn` (`sdk-host.ts:202-211`) безусловно (кроме `this.ended`) кладёт ход в `makePushableInput` — неограниченную FIFO (`:74-109`), которую `query()` дочитает после текущего хода. Дизайн прямо рассчитан на «положить ход, пока занят» (комментарий `:121-127`). То есть отказ — чисто предусловие движка; если бы движок просто звал `hostSend` для достижимого хоста, занятый оркестратор корректно встал бы в очередь.

---

## 5. Минимальный план фикса (без переписывания рантайма)

### Общая опора: ввести «достижимость» хоста = `socket OK || PID жив || event-лог свеж`
Сейчас liveness = только сокет-проба (+ PID-fallback лишь при «толстом» хендле). Предлагается дополнить пробу свежестью `events.ndjson` (mtime), чтобы пишущий-сейчас хост никогда не считался мёртвым/stuck.

### Симптом 1 — end→resume луп → чистый IDLE/waiting
- **Не воскрешать здоровую сессию вхолостую.** В `ensureOrchestratorInternal` (`session-manager.ts:2311-2319`): не вызывать `restore()` для оркестратора, который завершил ход чисто / просто idle. Воскрешать только при реальной смерти хоста И наличии работы (входящего сообщения/хода), а не на каждый полл/`ensureOrchestrator`.
- **`exited`-по-чистому-завершению ≠ restorable.** Различать «хост-процесс вышел» и «сессию надо реанимировать»: либо маппить turn-end+alive в стабильный `idle`/`needs_input` (не `exited`, не `stuck`), либо не считать `runtime.state="exited"` restorable, если последний `result` был успешным (можно прочитать хвост `events.ndjson`).
- **Долгоживущий хост.** Логи показывают, что хост уже остаётся живым после хода — главное перестать его убивать (симптом 3) и авто-resume вхолостую. Дополнительно: пустой resume (без промпта) не должен завершаться мгновенно — хост должен встать в idle-ожидание следующего `send`.

### Симптом 2 — ложный stuck/probe_failure → терпеть занятый/idle живой хост
- **PID-fallback всегда**: гарантировать `hostPid>0` в `handle.data` на пути полла/доставки (наполнять «тонкий» хендл из `session.json`), чтобы сокет-таймаут не давал ложный `false`.
- **Свежесть event-лога**: в `isAlive` (или в активити-сигнале поллера) учитывать mtime `events.ndjson` — лог моложе N сек ⇒ хост жив+активен ⇒ ни `probe_failure`, ни idle-beyond-threshold.
- **Idle-beyond-threshold (путь B)**: не эскалировать в `stuck` здоровый-idle (живой хост + последний `result` success), и/или исключить оркестраторов (законно ждут воркеров), и/или требовать корроборации dead-evidence.

### Симптом 3 — send живому-занятому → очередь, а не restore
- В `prepareSession`/`send`: если хост **достижим** (socket || pid || свежий лог) — сразу `hostSend` (хост сам поставит ход в FIFO), НЕ требовать idle/terminal и НЕ ходить в `restore`.
- `restore`-путь оставить ТОЛЬКО для реально мёртвого хоста (`exited`/`missing`); для живой не-терминальной сессии доставка = push.
- Опционально (если хост реально недостижим, но не терминален): лёгкий движковый mailbox — буфернуть сообщение и отдать при следующем подъёме, вместо throw.

---

## Карта файлов
- `packages/plugins/runtime-sdk/src/index.ts` — `isAlive`+PID-fallback `:155-169`; strip AO_SDK_* `:73-77`; create/spawn `:55-145`.
- `packages/plugins/runtime-sdk/src/sdk-host.ts` — `makePushableInput` FIFO `:74-109`; `submitTurn` `:202-211`; `consume`+`finally end()` `:268-318`; standalone/shutdown `:386-515`; блокирующий `appendFileSync` `:423`; `case "send"` `:522-523`.
- `packages/plugins/runtime-sdk/src/sdk-client.ts` — `hostRequest` fallback-on-timeout `:53-87`; `hostStatus` 2с `:98-107`; `hostIsAlive` `:110-113`; `hostSend` `:41-50`.
- `packages/core/src/session-manager.ts` — `ensureOrchestratorInternal` restore-trigger `:2311-2327`; `send` `:2998`; `prepareSession` проба `:3179-3224`; `sendWithConfirmation` `:3226-3281`; `restoreForDelivery` `:3147-3177`; `restore` throw `:3554-3572`; `restore` env/AO_SDK_RESUME `:3726-3799`.
- `packages/core/src/types.ts` — `TERMINAL_STATUSES` `:228`; `NON_RESTORABLE_STATUSES={}` `:241`; `isTerminalSession` `:243-262`; `isRestorable` `:264-277`.
- `packages/core/src/lifecycle-manager.ts` — проба `:1124-1154`; activity→exited `:1223-1227`; idle-beyond-threshold→stuck `:1576-1588`; weak-evidence/default tail `:1590-1642`; orchestrator kind `:1555`; поллер `:3422-3430`.
- `packages/core/src/lifecycle-status-decisions.ts` — пороги `:17-19,28`; `createDetectingDecision`→stuck `:129-175`; `resolveProbeDecision` `:299-387`.
- `packages/plugins/agent-claude-code/src/activity-detection.ts` — turn-end по возрасту JSONL `:360-448`; удалённые `result`/`tool_use` кейсы `:407-411`.
- `packages/core/src/recovery/*` — on-demand, без периодического вызывателя; stuck на max-attempts `actions.ts:106-117`.
