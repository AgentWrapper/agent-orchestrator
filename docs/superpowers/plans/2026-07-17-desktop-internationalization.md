# Desktop Internationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship complete English and Simplified Chinese desktop UI support, follow the OS language on first launch, persist user overrides, package a separate Remote app, and verify it against `192.168.2.220`.

**Architecture:** Bundle typed local i18next resources shared by Electron main and the React renderer. Electron owns locale persistence and resolves OS language before window creation; preload exposes a narrow locale IPC bridge and the renderer initializes before its first React render. Migrate every application-owned UI literal in bounded surface groups while leaving daemon protocols and external/user content unchanged.

**Tech Stack:** Electron 33, React 19, TypeScript 5.6, i18next, react-i18next, Radix UI, Vitest, Testing Library, Playwright

## Global Constraints

- Effective locales are exactly `en` and `zh-CN`; every `zh*` OS locale resolves to `zh-CN`, all others to `en`.
- Preference values are exactly `system`, `en`, and `zh-CN`; missing/corrupt/unknown state resolves to `system`.
- Preference files live under each build's existing Electron userData directory, never SQLite, running.json, localStorage, or the daemon.
- Initialize locale before `createWindow` in main and before `createRoot` in renderer.
- Do not change daemon REST, SSE, WebSocket, terminal, SQLite, session, SCM, or Git contracts.
- Do not translate brands, repository/branch/path/code/command values, provider data, agent output, terminal output, or Issue/PR/MR/review/comment content.
- English is the fallback and the default test locale; do not deploy a partially translated build.
- Keep `/Applications/Agent Orchestrator.app` untouched and install only the separately named Remote package.

---

### Task 1: Typed Locale Foundation

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/shared/locale.ts`
- Create: `frontend/src/shared/locale.test.ts`
- Create: `frontend/src/shared/i18n/en.ts`
- Create: `frontend/src/shared/i18n/zh-CN.ts`
- Create: `frontend/src/shared/i18n/resources.ts`
- Create: `frontend/src/shared/i18n/resources.test.ts`
- Create: `frontend/src/i18next.d.ts`

**Interfaces:**
- Produces: `LocalePreference`, `SupportedLocale`, `LocaleSnapshot`, `resolveLocaleSnapshot`, and typed local `resources` consumed by main and renderer.

- [ ] **Step 1: Write failing locale-resolution and resource-parity tests**

```ts
it.each([
	["zh-CN", "zh-CN"], ["zh-Hans", "zh-CN"], ["zh_TW", "zh-CN"],
	["en-US", "en"], ["fr-FR", "en"], [undefined, "en"],
])("resolves %s to %s", (input, expected) => {
	expect(resolveSupportedLocale(input)).toBe(expected);
});

it("falls back invalid preferences to system", () => {
	expect(resolveLocaleSnapshot("broken", "zh-CN")).toEqual({
		preference: "system", effectiveLocale: "zh-CN", systemLocale: "zh-CN",
	});
});

it("keeps English and Chinese key sets identical and non-empty", () => {
	expect(flattenKeys(zhCN)).toEqual(flattenKeys(en));
	expect(flattenLeaves(en).every(Boolean)).toBe(true);
	expect(flattenLeaves(zhCN).every(Boolean)).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cd frontend
npm test -- --run src/shared/locale.test.ts src/shared/i18n/resources.test.ts
```

Expected: FAIL because locale modules do not exist.

- [ ] **Step 3: Install runtime dependencies**

```bash
cd frontend
npm install i18next react-i18next
```

Expected: package and lock files add both runtime dependencies without unrelated upgrades.

- [ ] **Step 4: Implement locale types and resolution**

```ts
export const localePreferences = ["system", "en", "zh-CN"] as const;
export type LocalePreference = (typeof localePreferences)[number];
export type SupportedLocale = "en" | "zh-CN";
export type LocaleSnapshot = {
	preference: LocalePreference;
	effectiveLocale: SupportedLocale;
	systemLocale: SupportedLocale;
};

export function coerceLocalePreference(raw: unknown): LocalePreference {
	return localePreferences.includes(raw as LocalePreference) ? (raw as LocalePreference) : "system";
}

export function resolveSupportedLocale(raw: string | undefined): SupportedLocale {
	return /^zh(?:-|_|$)/i.test(raw ?? "") ? "zh-CN" : "en";
}

export function resolveLocaleSnapshot(raw: unknown, osLocale: string): LocaleSnapshot {
	const preference = coerceLocalePreference(raw);
	const systemLocale = resolveSupportedLocale(osLocale);
	return { preference, systemLocale, effectiveLocale: preference === "system" ? systemLocale : preference };
}
```

Create canonical nested English resources, a recursive string-shape type, Chinese resources satisfying that shape, and `{ en: { translation: en }, "zh-CN": { translation: zhCN } }`. Add i18next TypeScript augmentation with `defaultNS: "translation"`, English resource typing, and `returnNull: false`.

- [ ] **Step 5: Verify GREEN and typecheck**

```bash
cd frontend
npm test -- --run src/shared/locale.test.ts src/shared/i18n/resources.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the foundation**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/shared/locale.ts frontend/src/shared/locale.test.ts frontend/src/shared/i18n frontend/src/i18next.d.ts
git commit -m "feat: add typed desktop translations"
```

### Task 2: Locale Persistence and Main-Process Controller

**Files:**
- Create: `frontend/src/main/locale-settings.ts`
- Create: `frontend/src/main/locale-settings.test.ts`
- Create: `frontend/src/main/i18n.ts`
- Create: `frontend/src/main/locale-controller.ts`
- Create: `frontend/src/main/locale-controller.test.ts`

**Interfaces:**
- Consumes: shared locale types/resources from Task 1.
- Produces: atomic preference persistence, main translator, and testable `LocaleController`.

- [ ] **Step 1: Write failing persistence tests**

Test missing/corrupt/unknown input, roundtrip, mode-safe atomic write, no leftover temp file, and a forced write/rename failure:

```ts
it("round-trips a valid preference", async () => {
	await writeLocalePreference(dir, "zh-CN");
	await expect(readLocalePreference(dir)).resolves.toBe("zh-CN");
	const raw = JSON.parse(await readFile(join(dir, LOCALE_SETTINGS_FILE_NAME), "utf8"));
	expect(raw).toEqual({ preference: "zh-CN" });
});

it.each([undefined, "not-json", JSON.stringify({ preference: "bad" })])(
	"defaults missing or invalid state to system", async (raw) => {
		if (raw !== undefined) await writeFile(join(dir, LOCALE_SETTINGS_FILE_NAME), raw);
		await expect(readLocalePreference(dir)).resolves.toBe("system");
	},
);
```

- [ ] **Step 2: Write failing controller ordering/rollback tests**

```ts
it("writes before changing language and rebuilding menus", async () => {
	const calls: string[] = [];
	const controller = new LocaleController(deps({
		writePreference: async () => { calls.push("write"); },
		changeLanguage: async () => { calls.push("language"); },
		rebuildMenus: () => { calls.push("menu"); },
	}));
	await controller.initialize();
	await controller.set("zh-CN");
	expect(calls.slice(-3)).toEqual(["write", "language", "menu"]);
});

it("keeps the previous snapshot when persistence fails", async () => {
	const controller = new LocaleController(deps({ writePreference: async () => { throw new Error("disk"); } }));
	const before = await controller.initialize();
	await expect(controller.set("zh-CN")).rejects.toThrow();
	expect(controller.get()).toEqual(before);
});
```

- [ ] **Step 3: Run tests and verify RED**

```bash
cd frontend
npm test -- --run src/main/locale-settings.test.ts src/main/locale-controller.test.ts
```

Expected: FAIL because persistence/controller modules do not exist.

- [ ] **Step 4: Implement atomic settings and controller**

Persist `{ preference }` to `locale-settings.json` with directory mode `0750`, temp file mode `0600`, same-directory rename, and best-effort temp cleanup. Implement:

```ts
export type LocaleControllerDeps = {
	userDataDir: string;
	systemLocale: () => string;
	readPreference(dir: string): Promise<LocalePreference>;
	writePreference(dir: string, preference: LocalePreference): Promise<void>;
	changeLanguage(locale: SupportedLocale): Promise<unknown>;
	rebuildMenus(): void;
};

export class LocaleController {
	async initialize(): Promise<LocaleSnapshot>;
	get(): LocaleSnapshot;
	async set(preference: LocalePreference): Promise<LocaleSnapshot>;
}
```

`set` validates exact preference membership, writes first, computes the new snapshot, changes main i18next language, commits memory, rebuilds menus, and returns. A write failure performs none of the later steps. `main/i18n.ts` uses a dedicated `createInstance()` with local resources, English fallback, supported locales, `escapeValue:false`, and `initImmediate:false`.

- [ ] **Step 5: Verify GREEN**

```bash
cd frontend
npm test -- --run src/main/locale-settings.test.ts src/main/locale-controller.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit main locale state**

```bash
git add frontend/src/main/locale-settings.ts frontend/src/main/locale-settings.test.ts frontend/src/main/i18n.ts frontend/src/main/locale-controller.ts frontend/src/main/locale-controller.test.ts
git commit -m "feat: persist desktop language preference"
```

### Task 3: IPC, Pre-Render Initialization, and Language Settings

**Files:**
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/preload.ts`
- Modify: `frontend/src/preload.test.ts`
- Modify: `frontend/src/renderer/lib/bridge.ts`
- Modify: `frontend/src/renderer/test/setup.ts`
- Create: `frontend/src/renderer/i18n.ts`
- Create: `frontend/src/renderer/i18n.test.ts`
- Modify: `frontend/src/renderer/main.tsx`
- Create: `frontend/src/renderer/components/LanguageSettingsSection.tsx`
- Create: `frontend/src/renderer/components/LanguageSettingsSection.test.tsx`
- Modify: `frontend/src/renderer/components/GlobalSettingsForm.tsx`
- Modify: `frontend/src/renderer/components/GlobalSettingsForm.test.tsx`

**Interfaces:**
- Consumes: Task 2 controller.
- Produces: `window.ao.locale.get/set`, no-flash renderer initialization, and runtime language selection.

- [ ] **Step 1: Add failing bridge and language-section tests**

Assert preload invokes exact `locale:get`/`locale:set` channels. Test System/English/Chinese options, immediate success, Remote availability, save disable, and failure rollback:

```ts
it("keeps the previous language when saving fails", async () => {
	vi.mocked(window.ao!.locale.get).mockResolvedValue(englishSnapshot);
	vi.mocked(window.ao!.locale.set).mockRejectedValue(new Error("disk"));
	render(<LanguageSettingsSection />);
	await userEvent.click(await screen.findByRole("combobox", { name: "Language" }));
	await userEvent.click(screen.getByRole("option", { name: "简体中文" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Could not save language");
	expect(i18n.resolvedLanguage).toBe("en");
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cd frontend
npm test -- --run src/preload.test.ts src/renderer/i18n.test.ts src/renderer/components/LanguageSettingsSection.test.tsx src/renderer/components/GlobalSettingsForm.test.tsx
```

Expected: FAIL because locale IPC/UI does not exist.

- [ ] **Step 3: Wire main/preload/renderer locale initialization**

After `app.whenReady`, initialize `LocaleController` with `app.getPath("userData")` and `app.getLocale()` before `createWindow`. Register handlers returning `LocaleSnapshot`. Add preload and browser-fallback methods. Create a dedicated renderer instance:

```ts
export const i18n = createInstance().use(initReactI18next);

export async function initializeRendererI18n(locale: SupportedLocale): Promise<void> {
	if (!i18n.isInitialized) {
		await i18n.init({ resources, lng: locale, fallbackLng: "en", supportedLngs: ["en", "zh-CN"],
			interpolation: { escapeValue: false }, returnNull: false, initImmediate: false });
	} else {
		await i18n.changeLanguage(locale);
	}
}

export async function applyLocaleSnapshot(snapshot: LocaleSnapshot): Promise<void> {
	await initializeRendererI18n(snapshot.effectiveLocale);
	document.documentElement.lang = snapshot.effectiveLocale;
}
```

In `renderer/main.tsx`, await snapshot resolution and `applyLocaleSnapshot` before router creation, telemetry startup, and `createRoot`; use a navigator-derived snapshot if IPC fails.

- [ ] **Step 4: Add the Global Settings selector**

Render an unconditional `LanguageSettingsSection` card before Remote server/Updates/Migration. Use the existing Radix Select with `system|en|zh-CN`; call `locale.set` first and only then `applyLocaleSnapshot`. Disable while saving and show localized `settings.language.saveFailed` without the raw filesystem error. Under System show the translated effective language. No restart or Save button.

- [ ] **Step 5: Verify GREEN and typecheck**

```bash
cd frontend
npm test -- --run src/preload.test.ts src/renderer/i18n.test.ts src/renderer/components/LanguageSettingsSection.test.tsx src/renderer/components/GlobalSettingsForm.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit runtime language switching**

```bash
git add frontend/src/main.ts frontend/src/preload.ts frontend/src/preload.test.ts frontend/src/renderer/lib/bridge.ts frontend/src/renderer/test/setup.ts frontend/src/renderer/i18n.ts frontend/src/renderer/i18n.test.ts frontend/src/renderer/main.tsx frontend/src/renderer/components/LanguageSettingsSection.tsx frontend/src/renderer/components/LanguageSettingsSection.test.tsx frontend/src/renderer/components/GlobalSettingsForm.tsx frontend/src/renderer/components/GlobalSettingsForm.test.tsx frontend/src/shared/i18n
git commit -m "feat: switch desktop language at runtime"
```

### Task 4: Electron Menus and Native Dialogs

**Files:**
- Create: `frontend/src/main/application-menu.ts`
- Create: `frontend/src/main/application-menu.test.ts`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/main/auto-updater.ts`
- Create: `frontend/src/main/auto-updater.test.ts`

**Interfaces:**
- Consumes: main translator and LocaleController rebuild callback.
- Produces: deterministic localized native menus, About, folder chooser, and update prompts.

- [ ] **Step 1: Write failing English/Chinese menu and prompt tests**

Build templates with fixed translators and assert localized top-level labels while role/accelerator items remain unchanged. Mock `dialog.showMessageBox` and assert the three Chinese update prompt branches preserve current response behavior.

```ts
expect(buildApplicationMenuTemplate({ platform: "win32", productName: "Agent Orchestrator", t: zhT })
	.map((item) => item.label)).toEqual(["编辑", "视图", "窗口"]);
expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
	message: "自动保持 Agent Orchestrator 为最新版本？",
	buttons: ["启用自动更新", "暂不"],
}));
```

- [ ] **Step 2: Run tests and verify RED**

```bash
cd frontend
npm test -- --run src/main/application-menu.test.ts src/main/auto-updater.test.ts
```

Expected: FAIL because localized menu/prompt modules do not exist.

- [ ] **Step 3: Implement deterministic localized native UI**

`buildApplicationMenuTemplate({platform,productName,t})` returns standard app/Edit/View/Window role menus for macOS/Linux and the existing hidden role menu for Windows. Preserve all roles and accelerators. `rebuildApplicationMenu()` calls `Menu.setApplicationMenu` after locale init, window creation, and language change. Use `mainT` for About title/version/OK and the native chooser fallback. Change `ensureUpdatePrefs(stateDir, t)` to translate its buttons/message/detail while leaving raw updater/provider failures out of translations.

- [ ] **Step 4: Verify GREEN**

```bash
cd frontend
npm test -- --run src/main/application-menu.test.ts src/main/auto-updater.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit native localization**

```bash
git add frontend/src/main/application-menu.ts frontend/src/main/application-menu.test.ts frontend/src/main.ts frontend/src/main/auto-updater.ts frontend/src/main/auto-updater.test.ts frontend/src/shared/i18n
git commit -m "feat: localize desktop menus and dialogs"
```

### Task 5: Localized Errors, Time, Counts, and Notifications

**Files:**
- Modify: `frontend/src/renderer/lib/api-client.ts`
- Modify: `frontend/src/renderer/lib/api-client.test.ts`
- Modify: `frontend/src/renderer/lib/format-time.ts`
- Create: `frontend/src/renderer/lib/format-time.test.ts`
- Modify: `frontend/src/renderer/lib/notifications.ts`
- Modify: `frontend/src/renderer/lib/notifications.test.ts`
- Modify: `frontend/src/renderer/components/NotificationCenter.tsx`
- Modify: `frontend/src/renderer/components/NotificationCenter.test.tsx`
- Modify: `frontend/src/shared/i18n/en.ts`
- Modify: `frontend/src/shared/i18n/zh-CN.ts`

**Interfaces:**
- Consumes: initialized renderer i18next.
- Produces: localized error boundary, locale-aware time helpers, count interpolation, and shared notification presentation.

- [ ] **Step 1: Add failing English/Chinese helper tests**

```ts
it("localizes a stable daemon error code", async () => {
	await i18n.changeLanguage("zh-CN");
	expect(apiErrorMessage({ code: "DIRECTORY_PERMISSION_DENIED", message: "Directory permission denied" }))
		.toBe("没有权限访问该目录");
});

it("formats compact relative time in both locales", () => {
	const now = Date.parse("2026-07-17T12:00:00Z");
	expect(formatTimeCompact("2026-07-17T10:00:00Z", "en", now)).toMatch(/2.*ago/i);
	expect(formatTimeCompact("2026-07-17T10:00:00Z", "zh-CN", now)).toContain("2");
	expect(formatTimeCompact("2026-07-17T10:00:00Z", "zh-CN", now)).toContain("前");
});

it.each(["needs_input", "ready_to_merge", "pr_merged", "pr_closed_unmerged"])(
	"localizes %s notifications", async (type) => {
		await i18n.changeLanguage("zh-CN");
		expect(localizeNotification(notification({ type }), i18n.t).title).not.toBe(notification({ type }).title);
	},
);
```

Also test invalid/future/just-now dates, English and Chinese absolute date formatting, unknown error fallback, all four notification types, unknown notification preservation, and exactly one Electron notification using the same localized title/body as the in-app item.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd frontend
npm test -- --run src/renderer/lib/api-client.test.ts src/renderer/lib/format-time.test.ts src/renderer/lib/notifications.test.ts src/renderer/components/NotificationCenter.test.tsx
```

Expected: FAIL because locale-aware helpers and notification presentation do not exist.

- [ ] **Step 3: Implement stable error-code localization**

Keep `apiErrorCode` unchanged for control flow. Add an explicit `ERROR_CODE_KEYS` map and make `apiErrorMessage` prefer a translated known code, then a localized fallback plus the daemon's redacted structured message, then the localized generic error. Do not expose an arbitrary thrown transport error or credentials.

```ts
const ERROR_CODE_KEYS: Partial<Record<string, string>> = {
	DIRECTORY_PERMISSION_DENIED: "errors.codes.DIRECTORY_PERMISSION_DENIED",
	DIRECTORY_NOT_FOUND: "errors.codes.DIRECTORY_NOT_FOUND",
	DIRECTORY_ALREADY_EXISTS: "errors.codes.DIRECTORY_ALREADY_EXISTS",
	INVALID_DIRECTORY_NAME: "errors.codes.INVALID_DIRECTORY_NAME",
	SCM_CREDENTIAL_STORE_FAILED: "errors.codes.SCM_CREDENTIAL_STORE_FAILED",
};

export function apiErrorMessage(error: unknown, fallback = i18n.t("errors.generic")): string {
	const code = apiErrorCode(error);
	const key = code ? ERROR_CODE_KEYS[code] : undefined;
	if (key && i18n.exists(key)) return i18n.t(key);
	const message = structuredAPIMessage(error);
	return message ? i18n.t("errors.withDetail", { summary: fallback, detail: message }) : fallback;
}
```

Populate the explicit map/resource entries for every stable code currently surfaced by renderer workflows, discovered from controller error envelopes and existing component control-flow checks.

- [ ] **Step 4: Implement locale-aware time and notification presentation**

```ts
export function formatTimeCompact(
	iso: string | null | undefined,
	locale: SupportedLocale = (i18n.resolvedLanguage as SupportedLocale) || "en",
	now = Date.now(),
): string {
	if (!iso) return "";
	const timestamp = Date.parse(iso);
	if (!Number.isFinite(timestamp)) return "";
	const diffMinutes = Math.round((timestamp - now) / 60_000);
	const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
	if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute");
	const hours = Math.round(diffMinutes / 60);
	if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
	return formatter.format(Math.round(hours / 24), "day");
}
```

Add `formatDateTime` using `Intl.DateTimeFormat`. Add `localizeNotification(notification,t)` mapping exactly `needs_input`, `ready_to_merge`, `pr_merged`, and `pr_closed_unmerged`; use session ID or safely parsed PR/MR URL metadata, never regex-parse stored English title/body. Preserve unknown/external content. Use the same localized object in NotificationCenter and `aoBridge.notifications.show`.

- [ ] **Step 5: Verify GREEN**

```bash
cd frontend
npm test -- --run src/renderer/lib/api-client.test.ts src/renderer/lib/format-time.test.ts src/renderer/lib/notifications.test.ts src/renderer/components/NotificationCenter.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit shared localization behavior**

```bash
git add frontend/src/renderer/lib/api-client.ts frontend/src/renderer/lib/api-client.test.ts frontend/src/renderer/lib/format-time.ts frontend/src/renderer/lib/format-time.test.ts frontend/src/renderer/lib/notifications.ts frontend/src/renderer/lib/notifications.test.ts frontend/src/renderer/components/NotificationCenter.tsx frontend/src/renderer/components/NotificationCenter.test.tsx frontend/src/shared/i18n
git commit -m "feat: localize desktop status messages"
```

### Task 6: Shell and Project Workflow Migration

**Files:**
- Modify: `frontend/src/renderer/components/ConfirmDialog.tsx`
- Modify: `frontend/src/renderer/components/Sidebar.tsx`
- Modify: `frontend/src/renderer/components/ShellTopbar.tsx`
- Modify: `frontend/src/renderer/components/TitlebarNav.tsx`
- Modify: `frontend/src/renderer/components/WindowTitlebar.tsx`
- Modify: `frontend/src/renderer/components/TelemetryBoundary.tsx`
- Modify: `frontend/src/renderer/components/ui/breadcrumb.tsx`
- Modify: `frontend/src/renderer/components/ui/dialog.tsx`
- Modify: `frontend/src/renderer/components/ui/sheet.tsx`
- Modify: `frontend/src/renderer/components/ui/sidebar.tsx`
- Modify: `frontend/src/renderer/routes/_shell.tsx`
- Modify: `frontend/src/renderer/types/workspace.ts`
- Modify: `frontend/src/renderer/components/CreateProjectFlow.tsx`
- Modify: `frontend/src/renderer/components/CreateProjectAgentSheet.tsx`
- Modify: `frontend/src/renderer/components/ProjectSettingsForm.tsx`
- Modify: `frontend/src/renderer/components/IntakeFields.tsx`
- Modify: `frontend/src/renderer/components/SCMConnectionFields.tsx`
- Modify: `frontend/src/renderer/components/OrchestratorReplacementDialog.tsx`
- Modify: `frontend/src/renderer/components/RestoreUnavailableDialog.tsx`
- Modify: corresponding existing component and integration tests
- Modify: `frontend/src/shared/i18n/en.ts`
- Modify: `frontend/src/shared/i18n/zh-CN.ts`

**Interfaces:**
- Consumes: React i18next hooks and localized error helpers.
- Produces: fully translated shell, project onboarding, SCM connection, and project settings surfaces.

- [ ] **Step 1: Add Chinese shell/project smoke assertions before migration**

In focused existing tests, switch the test i18n instance to `zh-CN`, render Sidebar, CreateProjectFlow, CreateProjectAgentSheet, SCMConnectionFields, and ProjectSettingsForm, and assert translated accessible names and headings while repository paths/provider names remain unchanged.

```ts
await i18n.changeLanguage("zh-CN");
renderPickerOrForm();
expect(await screen.findByRole("heading", { name: "添加项目" })).toBeInTheDocument();
expect(screen.getByLabelText("仓库")).toHaveValue("group/subgroup/project");
expect(screen.getByText("GitLab")).toBeInTheDocument();
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd frontend
npm test -- --run src/renderer/components/Sidebar.test.tsx src/renderer/components/CreateProjectAgentSheet.test.tsx src/renderer/components/ProjectSettingsForm.test.tsx src/renderer/components/SCMConnectionFields.test.tsx src/renderer/__tests__/integration/board-empty-states.test.tsx
```

Expected: Chinese assertions FAIL while existing English assertions remain PASS.

- [ ] **Step 3: Migrate every application-owned literal in the listed files**

Use `const { t } = useTranslation()` in components and semantic keys for text, `aria-label`, title, placeholder, status, validation, and error fallback values. Non-React workspace/status helpers use the renderer i18n instance or accept `TFunction`. Do not translate provider names, agent names, project IDs, paths, repo keys, branches, URLs, or SCM content.

```tsx
const { t } = useTranslation();
<Dialog.Title>{t("projects.create.title")}</Dialog.Title>
<Input aria-label={t("projects.scm.repository")} placeholder={t("projects.scm.gitlabRepositoryPlaceholder")} />
<Button>{creating ? t("projects.create.creating") : t("projects.create.submit")}</Button>
```

Rename the misleading English `Import to Agent Orchestrator` copy through translations to `Add project` / `添加项目`; behavior remains unchanged.

- [ ] **Step 4: Verify GREEN and restore test locale isolation**

```bash
cd frontend
npm test -- --run src/renderer/components/Sidebar.test.tsx src/renderer/components/CreateProjectAgentSheet.test.tsx src/renderer/components/ProjectSettingsForm.test.tsx src/renderer/components/SCMConnectionFields.test.tsx src/renderer/__tests__/integration/board-empty-states.test.tsx
npm run typecheck
```

Expected: PASS in both languages. Each language-specific test restores English afterward.

- [ ] **Step 5: Commit shell/project migration**

```bash
git add frontend/src/renderer frontend/src/shared/i18n
git commit -m "feat: localize shell and project workflows"
```

### Task 7: Sessions, Terminal, PR/MR, and Review Migration

**Files:**
- Modify: `frontend/src/renderer/components/BoardEmptyState.tsx`
- Modify: `frontend/src/renderer/components/SessionsBoard.tsx`
- Modify: `frontend/src/renderer/components/NewTaskDialog.tsx`
- Modify: `frontend/src/renderer/components/SessionView.tsx`
- Modify: `frontend/src/renderer/components/CenterPane.tsx`
- Modify: `frontend/src/renderer/components/TerminalPane.tsx`
- Modify: `frontend/src/renderer/hooks/useTerminalSession.ts`
- Modify: `frontend/src/renderer/lib/rename-session.ts`
- Create: `frontend/src/renderer/lib/rename-session.test.ts`
- Modify: `frontend/src/renderer/lib/restart-orchestrator.ts`
- Modify: `frontend/src/renderer/lib/spawn-orchestrator.ts`
- Modify: `frontend/src/renderer/components/SessionInspector.tsx`
- Modify: `frontend/src/renderer/components/PRSummaryDisplay.tsx`
- Modify: `frontend/src/renderer/components/PullRequestsPage.tsx`
- Modify: `frontend/src/renderer/lib/pr-display.ts`
- Modify: corresponding existing tests
- Modify: `frontend/src/shared/i18n/en.ts`
- Modify: `frontend/src/shared/i18n/zh-CN.ts`

**Interfaces:**
- Consumes: localized time/count/error helpers.
- Produces: translated task/session/terminal control UI and provider-correct PR/MR/review UI.

- [ ] **Step 1: Add failing Chinese session and PR/MR tests**

Exercise board empty state, New task, inspector, terminal controls, GitHub Pull request labels, GitLab Merge request labels, changed-file counts, review states, and process-exited/terminal-error markers. Assert raw task title, branch, path, review body, and terminal bytes remain unchanged.

- [ ] **Step 2: Verify RED**

```bash
cd frontend
npm test -- --run src/renderer/components/SessionsBoard.test.tsx src/renderer/components/NewTaskDialog.test.tsx src/renderer/components/SessionInspector.test.tsx src/renderer/components/PRSummaryDisplay.test.tsx src/renderer/components/PullRequestsPage.test.tsx src/renderer/components/TerminalPane.test.tsx src/renderer/hooks/useTerminalSession.test.tsx src/renderer/lib/pr-display.test.ts
```

Expected: Chinese assertions FAIL.

- [ ] **Step 3: Migrate listed surfaces and remove manual English pluralization**

Use i18next `count` options for file/line/comment/reviewer/notification counts. Replace `changeRequestName` and display helpers with translator-aware provider mappings. Translate application-injected terminal markers but never terminal process output.

```ts
export function changeRequestName(provider: SCMProvider, plural: boolean, t: TFunction): string {
	const kind = provider === "gitlab" ? "mergeRequest" : "pullRequest";
	return t(`scm.${kind}.${plural ? "plural" : "singular"}`);
}

t("scm.summary.changedFiles", { count: pr.changedFiles })
```

- [ ] **Step 4: Verify GREEN and typecheck**

Run the Step 2 command, then `npm run typecheck`. Expected: PASS with English and Chinese provider vocabulary correct.

- [ ] **Step 5: Commit session/SCM migration**

```bash
git add frontend/src/renderer frontend/src/shared/i18n
git commit -m "feat: localize sessions and code reviews"
```

### Task 8: Remote, Browser, Settings, Migration, and Feedback Migration

**Files:**
- Modify: `frontend/src/renderer/components/BrowserPanel.tsx`
- Modify: `frontend/src/renderer/components/ConnectMobileModal.tsx`
- Modify: `frontend/src/renderer/components/RemoteServerSettings.tsx`
- Modify: `frontend/src/renderer/components/RemoteDirectoryPickerDialog.tsx`
- Modify: `frontend/src/renderer/components/GlobalSettingsForm.tsx`
- Modify: `frontend/src/renderer/components/UpdatesSection.tsx`
- Modify: `frontend/src/renderer/components/MigrationPopup.tsx`
- Modify: `frontend/src/renderer/components/MigrationSection.tsx`
- Modify: `frontend/src/renderer/components/ReportProblemDialog.tsx`
- Modify: `frontend/src/renderer/lib/report-problem.ts`
- Modify: corresponding existing tests
- Modify: `frontend/src/shared/i18n/en.ts`
- Modify: `frontend/src/shared/i18n/zh-CN.ts`

**Interfaces:**
- Consumes: Task 3 language settings, Task 5 formatting, and the completed remote-directory creation UI.
- Produces: translated remaining renderer surfaces.

- [ ] **Step 1: Add failing Chinese tests for every remaining surface**

Test Browser actions/annotation errors, Connect Mobile, masked Remote password/reveal, Remote path/new-folder controls, update states, migration dates/status, and feedback/report dialogs. Keep host, port, password mask, paths, URLs, versions, migration counts, and external report content unchanged.

- [ ] **Step 2: Verify RED**

```bash
cd frontend
npm test -- --run src/renderer/components/BrowserPanel.test.tsx src/renderer/components/ConnectMobileModal.test.tsx src/renderer/components/RemoteServerSettings.test.tsx src/renderer/components/RemoteDirectoryPickerDialog.test.tsx src/renderer/components/GlobalSettingsForm.test.tsx src/renderer/components/MigrationPopup.test.tsx src/renderer/lib/report-problem.test.ts
```

Expected: Chinese assertions FAIL.

- [ ] **Step 3: Migrate the listed files**

Replace every application-owned literal and accessible label with semantic translations. Replace MigrationSection's raw `toLocaleString()` with Task 5 `formatDateTime`. Keep the connection password masked and never put secrets in translation options, errors, telemetry, or screenshots.

- [ ] **Step 4: Verify GREEN and typecheck**

Run the Step 2 command, then `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit remaining surface migration**

```bash
git add frontend/src/renderer frontend/src/shared/i18n
git commit -m "feat: complete Chinese desktop interface"
```

### Task 9: Literal Audit, Full Verification, Packaging, and Deployment

**Files:**
- Create: `frontend/scripts/i18n-audit.mjs`
- Create: `frontend/scripts/i18n-audit.test.mjs`
- Create: `frontend/scripts/i18n-allowlist.json`
- Modify: `frontend/package.json`
- Modify: `frontend/e2e/*` only where selectors must become locale-stable
- Modify: `docs/superpowers/specs/2026-07-17-desktop-internationalization-design.md` status after verified deployment

**Interfaces:**
- Consumes: all translated surfaces and the remote-directory plan.
- Produces: proof that no application-owned English remains, final packages, installed Remote app, and verified `220` deployment.

- [ ] **Step 1: Write a failing untranslated-literal audit**

Use the TypeScript compiler API to scan production main/renderer TS/TSX for JSX text and user-facing attributes/properties such as `aria-label`, `title`, `placeholder`, `message`, `detail`, `label`, `description`, and `subtitle`. Skip tests and translation resources. The explicit allowlist contains only product/provider names, protocol/status keys, code/commands/paths, logs/telemetry, and clearly external/mock data.

```js
if (violations.length) {
	for (const violation of violations) console.error(`${violation.file}:${violation.line} ${violation.text}`);
	process.exitCode = 1;
}
```

Add `"i18n:audit": "node ./scripts/i18n-audit.mjs"` and run it before finishing migration. Expected first run: FAIL with any remaining application literals; migrate each real violation or justify only a narrow allowlist entry.

- [ ] **Step 2: Verify resource parity and the literal audit**

```bash
cd frontend
npm test -- --run src/shared/i18n/resources.test.ts
npm run i18n:audit
```

Expected: PASS, no empty/missing translation keys, no unapproved UI literals.

- [ ] **Step 3: Run the full automated suite**

```bash
npm run lint
cd frontend
npm test
npm run typecheck
cd ..
git diff --check
```

Expected: all Go/frontend tests, lint, typecheck, and whitespace checks PASS.

- [ ] **Step 4: Build both application flavors**

```bash
cd frontend
npm run package
npm run package:remote
npm run make:remote
```

Expected: normal and Remote arm64 macOS bundles build; Remote bundle has the distinct product name/bundle ID, contains `remote-client.json`, and contains no daemon binary.

- [ ] **Step 5: Perform visual verification in English and Chinese**

Use Playwright at `960x640`, `1320x860`, and a wide desktop viewport. Capture Global settings, Add project, project settings/SCM, board, session inspector/reviews, Remote connection, and Remote directory/new-folder UI in both locales. Assert `scrollWidth <= clientWidth`, no clipped button text, no incoherent overlap, correct document `lang`, and nonblank rendered content.

- [ ] **Step 6: Deploy the new daemon binary to `ubuntu@192.168.2.220`**

Complete Task 4 of the remote-directory plan. Verify the exact service binary commit/version, enabled+active status, loopback health, authenticated `0.0.0.0:3011`, and create/browse/duplicate-error behavior without printing credentials.

- [ ] **Step 7: Install only the final Remote client**

Verify the source bundle, then replace/install only `/Applications/Agent Orchestrator Remote.app`; record the original `/Applications/Agent Orchestrator.app` hash before and after and prove it is unchanged. Do not launch or close the original app. Preserve `~/.ao/electron-remote` so the saved `192.168.2.220:3011` connection remains available.

- [ ] **Step 8: Run installed-app end-to-end smoke checks**

Launch the new Remote app separately. Verify automatic reconnection, System locale resolving to Chinese on the current Mac, runtime switching English/Chinese and persistence after Remote app restart, masked/revealable connection password, Remote New folder -> create -> auto-enter -> Select without Finder, project/session REST, SSE updates, terminal WebSocket, and GitLab connection status. Confirm daemon and sessions remain active after Remote client exit.

- [ ] **Step 9: Commit verification metadata and mark design deployed**

Update the design status only after all evidence above passes. Do not commit credentials, screenshots containing secrets, generated app bundles, or daemon run state.

```bash
git add frontend/scripts frontend/package.json frontend/package-lock.json frontend/e2e docs/superpowers/specs/2026-07-17-desktop-internationalization-design.md
git commit -m "test: verify localized remote desktop"
```
