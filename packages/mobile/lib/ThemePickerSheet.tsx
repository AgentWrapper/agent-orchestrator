import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { haptics } from "./haptics";
import type { Theme } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { preferenceLabel, type ThemePreference } from "./themePreference";
import { SheetScreen } from "./ui";

// Light / Dark / System, in the same order and with the same labels as the
// desktop app's Theme dropdown, so the two describe the setting identically.
const OPTIONS: { value: ThemePreference; icon: keyof typeof Feather.glyphMap; hint: string }[] = [
	{ value: "light", icon: "sun", hint: "Always light" },
	{ value: "dark", icon: "moon", hint: "Always dark" },
	{ value: "system", icon: "smartphone", hint: "Follow device settings" },
];

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
	const s = useThemedStyles(makeStyles);

	return (
		<SheetScreen title="Theme" subtitle="Applies across the whole app.">
			<View style={{ paddingTop: 8 }}>
				{OPTIONS.map((o) => {
					const selected = preference === o.value;
					return (
						<Pressable
							key={o.value}
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
								onSelect(o.value);
								onClose();
							}}
							style={({ pressed }) => [s.option, pressed && s.optionPressed]}
						>
							<Feather name={o.icon} size={17} color={selected ? t.blue : t.textTertiary} />
							<View style={{ flex: 1 }}>
								<Text style={[s.label, selected && { color: t.blue }]}>{preferenceLabel(o.value)}</Text>
								<Text style={s.hint}>{o.hint}</Text>
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
