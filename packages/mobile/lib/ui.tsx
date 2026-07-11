import { Feather } from "@expo/vector-icons";
import { memo, useEffect, useRef, type ReactNode } from "react";
import {
	ActivityIndicator,
	Animated,
	Image,
	Pressable,
	StyleSheet,
	Text,
	View,
	type StyleProp,
	type TextStyle,
	type ViewStyle,
} from "react-native";
import { statusVisual, theme } from "./theme";
// AO mascot glyph (transparent) shown beside each screen heading.
import MASCOT from "../assets/mascot.png";

// A gently breathing dot - the only motion in the UI, reserved for "working".
// Memoized so an unrelated parent re-render doesn't tear down and restart the
// Animated loop (which causes a visible flicker and per-tick allocations).
export const Dot = memo(function Dot({
	color,
	size = 9,
	breathing = false,
}: {
	color: string;
	size?: number;
	breathing?: boolean;
}) {
	const pulse = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		if (!breathing) return;
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(pulse, { toValue: 0.35, duration: 1200, useNativeDriver: true }),
				Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [breathing, pulse]);

	return (
		<Animated.View
			style={{
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundColor: color,
				opacity: breathing ? pulse : 1,
			}}
		/>
	);
});

// A selectable pill - used by the project switcher, PR filters, and spawn picker
// so the active/inactive color logic lives in exactly one place.
export function Pill({
	label,
	active,
	onPress,
	style,
	textStyle,
}: {
	label: string;
	active: boolean;
	onPress: () => void;
	style?: StyleProp<ViewStyle>;
	textStyle?: StyleProp<TextStyle>;
}) {
	return (
		<Pressable onPress={onPress} style={[s.pill, active && s.pillActive, style]}>
			<Text numberOfLines={1} style={[s.pillText, active && s.pillTextActive, textStyle]}>
				{label}
			</Text>
		</Pressable>
	);
}

export function StatusBadge({ status }: { status?: string | null }) {
	const v = statusVisual(status);
	return (
		<View style={s.badge}>
			<Dot color={v.color} breathing={v.breathing} size={8} />
			<Text style={[s.badgeText, { color: v.color }]}>{v.label}</Text>
		</View>
	);
}

export function Chip({
	label,
	color = theme.textSecondary,
	tint = theme.bgSubtle,
	mono = false,
	icon,
}: {
	label: string;
	color?: string;
	tint?: string;
	mono?: boolean;
	icon?: keyof typeof Feather.glyphMap;
}) {
	return (
		<View style={[s.chip, { backgroundColor: tint }]}>
			{icon ? <Feather name={icon} size={11} color={color} style={{ marginRight: 4 }} /> : null}
			<Text style={[s.chipText, { color }, mono && { fontFamily: theme.fontMono, fontSize: 11 }]} numberOfLines={1}>
				{label}
			</Text>
		</View>
	);
}

export function Card({
	children,
	onPress,
	style,
}: {
	children: ReactNode;
	onPress?: () => void;
	style?: StyleProp<ViewStyle>;
}) {
	if (!onPress) return <View style={[s.card, style]}>{children}</View>;
	return (
		<Pressable onPress={onPress} style={({ pressed }) => [s.card, pressed && s.cardPressed, style]}>
			{children}
		</Pressable>
	);
}

export function SectionHeader({ label, color, count }: { label: string; color: string; count?: number }) {
	return (
		<View style={s.sectionHeader}>
			<View style={[s.sectionBar, { backgroundColor: color }]} />
			<Text style={s.sectionLabel}>{label.toUpperCase()}</Text>
			{count !== undefined ? <Text style={s.sectionCount}>{count}</Text> : null}
		</View>
	);
}

export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
	return (
		<View style={s.screenHeader}>
			<View style={{ flex: 1 }}>
				<View style={s.titleRow}>
					<Text style={s.screenTitle}>{title}</Text>
					<Image source={MASCOT} style={s.mascot} resizeMode="contain" />
				</View>
				{subtitle ? (
					<Text style={s.screenSubtitle} numberOfLines={1}>
						{subtitle}
					</Text>
				) : null}
			</View>
			{right}
		</View>
	);
}

export function Button({
	title,
	onPress,
	variant = "primary",
	loading = false,
	disabled = false,
	icon,
	style,
}: {
	title: string;
	onPress: () => void;
	variant?: "primary" | "ghost" | "danger";
	loading?: boolean;
	disabled?: boolean;
	icon?: keyof typeof Feather.glyphMap;
	style?: StyleProp<ViewStyle>;
}) {
	const isPrimary = variant === "primary";
	const isDanger = variant === "danger";
	const fg = isPrimary ? "#06101f" : isDanger ? theme.red : theme.blue;
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled || loading}
			style={({ pressed }) => [
				s.btn,
				isPrimary && s.btnPrimary,
				!isPrimary && s.btnGhost,
				isDanger && s.btnDanger,
				(disabled || loading) && { opacity: 0.5 },
				pressed && { opacity: 0.8 },
				style,
			]}
		>
			{loading ? (
				<ActivityIndicator color={fg} size="small" />
			) : (
				<View style={s.btnInner}>
					{icon ? <Feather name={icon} size={15} color={fg} style={{ marginRight: 7 }} /> : null}
					<Text style={[s.btnText, { color: fg }]}>{title}</Text>
				</View>
			)}
		</Pressable>
	);
}

export function ConnectionPill({ status }: { status: string }) {
	const color = status === "open" ? theme.green : status === "connecting" ? theme.amber : theme.textFaint;
	const label = status === "open" ? "live" : status === "connecting" ? "connecting" : "offline";
	return (
		<View style={s.connPill}>
			<Dot color={color} size={6} breathing={status === "connecting"} />
			<Text style={s.connText}>{label}</Text>
		</View>
	);
}

export function EmptyState({
	icon = "inbox",
	title,
	message,
	action,
}: {
	icon?: keyof typeof Feather.glyphMap;
	title: string;
	message?: string;
	action?: ReactNode;
}) {
	return (
		<View style={s.empty}>
			<View style={s.emptyIcon}>
				<Feather name={icon} size={26} color={theme.textTertiary} />
			</View>
			<Text style={s.emptyTitle}>{title}</Text>
			{message ? <Text style={s.emptyMsg}>{message}</Text> : null}
			{action ? <View style={{ marginTop: 18 }}>{action}</View> : null}
		</View>
	);
}

const s = StyleSheet.create({
	badge: { flexDirection: "row", alignItems: "center", gap: 6 },
	badgeText: { fontSize: 12, fontWeight: "600" },

	pill: {
		paddingHorizontal: 14,
		paddingVertical: 7,
		borderRadius: 20,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		backgroundColor: theme.bgElevated,
	},
	pillActive: { backgroundColor: theme.tintBlue, borderColor: theme.blue },
	pillText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
	pillTextActive: { color: theme.blue },

	chip: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 8,
		paddingVertical: 3,
		borderRadius: 6,
	},
	chipText: { fontSize: 11, fontWeight: "600" },

	card: {
		backgroundColor: theme.bgElevated,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		padding: 14,
	},
	cardPressed: { backgroundColor: theme.bgElevatedHover, borderColor: theme.borderDefault },

	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingTop: 20,
		paddingBottom: 10,
		gap: 9,
	},
	sectionBar: { width: 3, height: 13, borderRadius: 2 },
	sectionLabel: {
		color: theme.textSecondary,
		fontSize: 11,
		letterSpacing: 1.2,
		fontWeight: "700",
		flex: 1,
	},
	sectionCount: {
		color: theme.textTertiary,
		fontSize: 12,
		fontWeight: "700",
		fontFamily: theme.fontMono,
	},

	screenHeader: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingTop: 8,
		paddingBottom: 10,
		gap: 12,
	},
	titleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
	mascot: { width: 30, height: 26, marginTop: 3 },
	screenTitle: { color: theme.textPrimary, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
	screenSubtitle: { color: theme.textTertiary, fontSize: 12, marginTop: 1 },

	btn: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: "center" },
	btnInner: { flexDirection: "row", alignItems: "center" },
	btnPrimary: { backgroundColor: theme.blue },
	btnGhost: { borderWidth: 1, borderColor: theme.borderStrong, backgroundColor: theme.bgElevated },
	btnDanger: { borderColor: theme.tintRed, backgroundColor: theme.tintRed },
	btnText: { fontSize: 15, fontWeight: "700" },

	connPill: { flexDirection: "row", alignItems: "center", gap: 5 },
	connText: { color: theme.textTertiary, fontSize: 11, fontWeight: "600" },

	empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, minHeight: 320 },
	emptyIcon: {
		width: 64,
		height: 64,
		borderRadius: 18,
		backgroundColor: theme.bgElevated,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		alignItems: "center",
		justifyContent: "center",
		marginBottom: 18,
	},
	emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
	emptyMsg: {
		color: theme.textSecondary,
		fontSize: 13,
		lineHeight: 20,
		textAlign: "center",
		marginTop: 8,
		maxWidth: 300,
	},
});
