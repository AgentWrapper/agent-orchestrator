import { en, type StringShape } from "./en";

export const zhCN = {
	settings: {
		language: {
			title: "语言",
			system: "跟随系统",
			english: "英语",
			simplifiedChinese: "简体中文",
			effective: "当前使用{{language}}",
			saveFailed: "无法保存语言设置",
		},
	},
} as const satisfies StringShape<typeof en>;
