import type { SupportedLocale } from "../locale";

type BrowserAnnotationCopy = {
	hint: string;
	requestLabel: string;
	requestPlaceholder: string;
	cancel: string;
	send: string;
};

export const browserAnnotationCopy = {
	en: {
		hint: "Click an element to annotate. Press Esc to cancel.",
		requestLabel: "Annotation request",
		requestPlaceholder: "Describe what to change",
		cancel: "Cancel",
		send: "Send",
	},
	"zh-CN": {
		hint: "点击元素添加批注。按 Esc 取消。",
		requestLabel: "批注要求",
		requestPlaceholder: "描述需要修改的内容",
		cancel: "取消",
		send: "发送",
	},
} as const satisfies Record<SupportedLocale, BrowserAnnotationCopy>;
