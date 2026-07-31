import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTheme, useThemedStyles, useThemeState } from "../ThemeProvider";
import type { Theme } from "../theme";

// One field, one send button. There is no mode to choose: the screen sends to
// the agent, and reroutes to the PTY by itself when the daemon reports the
// session is paused on a permission prompt (see sendRoute.ts).
export function Composer({
	value,
	onChangeText,
	onSend,
	sending,
	keyboardVisible,
	onDismissKeyboard,
}: {
	value: string;
	onChangeText: (v: string) => void;
	onSend: () => void;
	sending: boolean;
	keyboardVisible: boolean;
	onDismissKeyboard: () => void;
}) {
	const t = useTheme();
	const { scheme } = useThemeState();
	const styles = useThemedStyles(makeStyles);
	const canSend = !!value.trim() && !sending;

	return (
		<View style={styles.bar}>
			<View style={styles.field}>
				<TextInput
					style={styles.input}
					value={value}
					onChangeText={onChangeText}
					placeholder="Message the agent…"
					placeholderTextColor={t.textFaint}
					multiline
					keyboardAppearance={scheme}
					selectionColor={t.blue}
					// No autoFocus: the bar is always mounted now, so focusing on mount
					// would pop the keyboard over the terminal every time the screen opens.
				/>
				{/* Only offered while there is a keyboard to dismiss, instead of a
				    permanent toggle that claimed to hide a keyboard it did not own. */}
				{keyboardVisible ? (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Hide keyboard"
						onPress={onDismissKeyboard}
						hitSlop={8}
						style={({ pressed }) => [styles.dismiss, pressed && { opacity: 0.6 }]}
					>
						<Feather name="chevron-down" size={16} color={t.textTertiary} />
					</Pressable>
				) : null}
			</View>

			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Send"
				disabled={!canSend}
				onPress={onSend}
				style={({ pressed }) => [styles.send, !canSend && { opacity: 0.35 }, pressed && { opacity: 0.8 }]}
			>
				<Feather name="send" size={17} color={t.onAccent} />
			</Pressable>
		</View>
	);
}

const CONTROL_SIZE = 40;

const makeStyles = (t: Theme) =>
	StyleSheet.create({
	bar: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 7,
		paddingHorizontal: 8,
		paddingTop: 2,
		paddingBottom: 7,
	},
	field: {
		flex: 1,
		flexDirection: "row",
		alignItems: "flex-end",
		minHeight: CONTROL_SIZE,
		// Caps growth at roughly four lines so a long prompt can't swallow the
		// terminal above it.
		maxHeight: 108,
		borderRadius: 11,
		borderWidth: 1,
		borderColor: t.borderDefault,
		backgroundColor: t.bgElevated,
		paddingLeft: 11,
		paddingRight: 4,
	},
	input: {
		flex: 1,
		color: t.textPrimary,
		fontSize: 15,
		paddingTop: 10,
		paddingBottom: 10,
		maxHeight: 106,
	},
	dismiss: { width: 28, height: CONTROL_SIZE, alignItems: "center", justifyContent: "center" },
	// Rounded square rather than a circle, so it matches the radius of the field
	// beside it instead of being the only circle in the dock.
	send: {
		width: CONTROL_SIZE,
		height: CONTROL_SIZE,
		borderRadius: 12,
		backgroundColor: t.blue,
		alignItems: "center",
		justifyContent: "center",
	},
});
