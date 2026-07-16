import {
	localePreferences,
	resolveLocaleSnapshot,
	type LocalePreference,
	type LocaleSnapshot,
	type SupportedLocale,
} from "../shared/locale";

export type LocaleControllerDeps = {
	userDataDir: string;
	systemLocale: () => string;
	readPreference(dir: string): Promise<LocalePreference>;
	writePreference(dir: string, preference: LocalePreference): Promise<void>;
	changeLanguage(locale: SupportedLocale): Promise<unknown>;
	rebuildMenus(): void;
};

export class LocaleController {
	private snapshot: LocaleSnapshot | undefined;

	constructor(private readonly deps: LocaleControllerDeps) {}

	async initialize(): Promise<LocaleSnapshot> {
		const preference = await this.deps.readPreference(this.deps.userDataDir);
		const snapshot = resolveLocaleSnapshot(preference, this.deps.systemLocale());
		await this.deps.changeLanguage(snapshot.effectiveLocale);
		this.snapshot = snapshot;
		return snapshot;
	}

	get(): LocaleSnapshot {
		if (this.snapshot === undefined) {
			throw new Error("LocaleController has not been initialized");
		}
		return this.snapshot;
	}

	async set(preference: LocalePreference): Promise<LocaleSnapshot> {
		if (!localePreferences.includes(preference)) {
			throw new TypeError(`Invalid locale preference: ${String(preference)}`);
		}

		await this.deps.writePreference(this.deps.userDataDir, preference);
		const snapshot = resolveLocaleSnapshot(preference, this.deps.systemLocale());
		await this.deps.changeLanguage(snapshot.effectiveLocale);
		this.snapshot = snapshot;
		this.deps.rebuildMenus();
		return snapshot;
	}
}
