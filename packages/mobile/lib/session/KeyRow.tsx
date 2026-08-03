import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Theme } from "../theme";
import { haptics } from "../haptics";
import { CONTROL_KEYS } from "./keys";
import { useThemedStyles } from "../ThemeProvider";

// The control-key row: one fixed row of eight keys that divide the width
// between them.
//
// It used to be a `flexWrap` row that also held zoom, the mic and two mode
// toggles, two of which carried `marginLeft: "auto"` — so turning a toggle on
// reflowed the whole second line. Fixed count, fixed height, `flex: 1` each:
// this row is pixel-identical in every state the screen can be in.
export function KeyRow({ onKey }: { onKey: (seq: string) => void }) {
	const styles = useThemedStyles(makeStyles);
	return (
		<View style={styles.row}>
			{CONTROL_KEYS.map((k) => (
				<Pressable
					key={k.label}
					accessibilityRole="button"
					accessibilityLabel={k.hint}
					onPress={() => {
						haptics.tap();
						onKey(k.seq);
					}}
					style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
				>
					<Text style={styles.keyText}>{k.label}</Text>
				</Pressable>
			))}
		</View>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
	row: {
		flexDirection: "row",
		gap: 5,
		paddingHorizontal: 8,
		paddingVertical: 7,
	},
	key: {
		flex: 1,
		backgroundColor: t.bgElevated,
		borderWidth: 1,
		borderColor: t.borderDefault,
		borderRadius: 7,
		paddingVertical: 9,
		alignItems: "center",
		justifyContent: "center",
	},
	keyPressed: { backgroundColor: t.tintBlue, borderColor: t.blue },
	keyText: { color: t.textPrimary, fontFamily: t.fontMono, fontSize: 14 },
});
