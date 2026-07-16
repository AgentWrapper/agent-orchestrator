export const en = {
	settings: {
		language: {
			title: "Language",
			system: "System default",
			english: "English",
			simplifiedChinese: "简体中文",
			effective: "Currently using {{language}}",
			saveFailed: "Could not save language",
		},
	},
} as const;

export type StringShape<T> = {
	readonly [Key in keyof T]: T[Key] extends string
		? string
		: T[Key] extends Record<string, unknown>
			? StringShape<T[Key]>
			: never;
};
