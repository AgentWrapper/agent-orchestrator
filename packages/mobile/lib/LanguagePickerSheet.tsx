import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { haptics } from "./haptics";
import { APP_LOCALES, LOCALE_NATIVE_LABELS, useT, type AppLocale } from "./i18n";
import type { Theme } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { SheetScreen } from "./ui";

export function LanguagePickerSheet({
	onClose,
	locale,
	onSelect,
}: {
	onClose: () => void;
	locale: AppLocale;
	onSelect: (locale: AppLocale) => void;
}) {
	const t = useTheme();
	const tr = useT();
	const s = useThemedStyles(makeStyles);

	return (
		<SheetScreen title={tr("language.title")} subtitle={tr("language.subtitle")}>
			<View style={{ paddingTop: 8 }}>
				{APP_LOCALES.map((code) => {
					const selected = locale === code;
					return (
						<Pressable
							key={code}
							accessibilityRole="button"
							accessibilityState={{ selected }}
							onPress={() => {
								haptics.select();
								onSelect(code);
								onClose();
							}}
							style={({ pressed }) => [s.option, pressed && s.optionPressed]}
						>
							<Feather name="globe" size={17} color={selected ? t.blue : t.textTertiary} />
							<Text style={[s.label, selected && { color: t.blue }]}>{LOCALE_NATIVE_LABELS[code]}</Text>
							{selected ? <Feather name="check" size={17} color={t.blue} /> : null}
						</Pressable>
					);
				})}
			</View>
		</SheetScreen>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
		option: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 2 },
		optionPressed: { opacity: 0.6 },
		label: { color: t.textPrimary, fontSize: 15, fontWeight: "500", flex: 1 },
	});
