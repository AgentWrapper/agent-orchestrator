import { useTranslation } from "react-i18next";

type LanguageToggleProps = {
	style?: React.CSSProperties;
};

// Shows the language you'd switch TO (not the current one) — tapping it flips
// between en and zh-CN. Sits left of NotificationCenter in the topbar.
export function LanguageToggle({ style }: LanguageToggleProps) {
	const { i18n } = useTranslation();
	const isZh = i18n.language === "zh-CN";
	const nextLocale = isZh ? "en" : "zh-CN";
	const label = isZh ? "EN" : "zh-CN";

	return (
		<button
			aria-label={`Switch to ${nextLocale === "en" ? "English" : "Chinese"}`}
			className="flex h-7 min-w-[42px] shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-border px-2 text-[11px] font-medium leading-none text-muted-foreground hover:border-border-strong hover:text-foreground"
			onClick={() => void i18n.changeLanguage(nextLocale)}
			style={style}
			type="button"
		>
			{label}
		</button>
	);
}