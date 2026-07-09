import { Children, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import { theme } from "./theme";
import { Dot } from "./ui";

export const WIDE_MIN = 768 as const;

export type Breakpoint = "phone" | "wide";

export function getBreakpoint(width: number): Breakpoint {
	return width >= WIDE_MIN ? "wide" : "phone";
}

export function useBreakpoint(): Breakpoint {
	const { width } = useWindowDimensions();
	return getBreakpoint(width);
}

export function WideContainer({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	return <View style={[styles.wideContainer, style]}>{children}</View>;
}

export function CardGrid({
	children,
	cardBasis,
	maxCardWidth,
	style,
	gap = 12,
}: {
	children: ReactNode;
	cardBasis: number;
	maxCardWidth?: number;
	style?: StyleProp<ViewStyle>;
	gap?: number;
}) {
	const wide = useBreakpoint() === "wide";
	const items = Children.toArray(children);

	return (
		<View style={[styles.cardGrid, wide && styles.cardGridWide, { gap }, style]}>
			{items.map((child, index) => (
				<View
					key={index}
					style={[
						styles.cardGridItem,
						wide && {
							flexBasis: cardBasis,
							flexGrow: 1,
							maxWidth: maxCardWidth,
						},
					]}
				>
					{child}
				</View>
			))}
		</View>
	);
}

export function BoardColumn({
	label,
	color,
	count,
	children,
	style,
	contentContainerStyle,
}: {
	label: string;
	color: string;
	count: number;
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	contentContainerStyle?: StyleProp<ViewStyle>;
}) {
	return (
		<View style={[styles.boardColumn, style]}>
			<View style={styles.boardColumnHeader}>
				<Dot color={color} size={8} />
				<Text style={styles.boardColumnLabel}>{label.toUpperCase()}</Text>
				<Text style={styles.boardColumnCount}>{count}</Text>
			</View>
			<ScrollView
				style={styles.boardColumnBody}
				contentContainerStyle={[styles.boardColumnContent, contentContainerStyle]}
			>
				{children}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	wideContainer: {
		width: "100%",
		maxWidth: 1600,
		alignSelf: "center",
	},
	cardGrid: {
		width: "100%",
		flexDirection: "column",
	},
	cardGridWide: {
		flexDirection: "row",
		flexWrap: "wrap",
		alignItems: "flex-start",
	},
	cardGridItem: {
		width: "100%",
		minWidth: 0,
	},
	boardColumn: {
		flex: 1,
		minWidth: 0,
		minHeight: 0,
		overflow: "hidden",
		borderRadius: 13,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		backgroundColor: theme.bgColumn,
	},
	boardColumnHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		paddingHorizontal: 14,
		paddingTop: 14,
		paddingBottom: 11,
	},
	boardColumnLabel: {
		flex: 1,
		color: theme.textSecondary,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.2,
	},
	boardColumnCount: {
		color: theme.textTertiary,
		fontSize: 12,
		fontWeight: "700",
		fontFamily: theme.fontMono,
	},
	boardColumnBody: {
		flex: 1,
		minHeight: 0,
	},
	boardColumnContent: {
		paddingBottom: 12,
	},
});
