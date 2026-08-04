import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { haptics } from "./haptics";
import { useT } from "./i18n";
import type { Theme } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { preferenceLabel, type ThemePreference } from "./themePreference";
import { SheetScreen } from "./ui";

// Light / Dark / System, in the same order and with the same labels as the
// desktop app's Theme dropdown, so the two describe the setting identically.
const OPTION_ICONS: Record<ThemePreference, keyof typeof Feather.glyphMap> = {
	light: "sun",
	dark: "moon",
	system: "smartphone",
};
const OPTION_HINT_KEYS = {
	light: "theme.hint.light",
	dark: "theme.hint.dark",
	system: "theme.hint.system",
} as const;
const OPTIONS: ThemePreference[] = ["light", "dark", "system"];

export function ThemePickerSheet({
	onClose,
	preference,
	onSelect,
}: {
	/** Dismisses the sheet route. */
	onClose: () => void;
	preference: ThemePreference;
	onSelect: (p: ThemePreference) => void;
}) {
	const t = useTheme();
	const tr = useT();
	const s = useThemedStyles(makeStyles);

	return (
		<SheetScreen title={tr("theme.title")} subtitle={tr("theme.subtitle")}>
			<View style={{ paddingTop: 8 }}>
				{OPTIONS.map((value) => {
					const selected = preference === value;
					return (
						<Pressable
							key={value}
							accessibilityRole="button"
							accessibilityState={{ selected }}
							onPress={() => {
								haptics.select();
								// Deliberately select-then-close, unlike the project and agent
								// sheets which dismiss first. Applying the theme before the
								// dismissal is what makes the repaint visible where the choice
								// was made, instead of only after the sheet is gone.
								//
								// Safe here specifically because onSelect is setPreference,
								// which never navigates. The other sheets hand their choice to
								// a caller that might, and onClose is router.back() — so there,
								// selecting first risks back() popping the destination.
								onSelect(value);
								onClose();
							}}
							style={({ pressed }) => [s.option, pressed && s.optionPressed]}
						>
							<Feather name={OPTION_ICONS[value]} size={17} color={selected ? t.blue : t.textTertiary} />
							<View style={{ flex: 1 }}>
								<Text style={[s.label, selected && { color: t.blue }]}>{preferenceLabel(value, tr)}</Text>
								<Text style={s.hint}>{tr(OPTION_HINT_KEYS[value])}</Text>
							</View>
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
		label: { color: t.textPrimary, fontSize: 15, fontWeight: "500" },
		hint: { color: t.textTertiary, fontSize: 12, marginTop: 2 },
	});
