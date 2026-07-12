import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { sessionTitle, type DashboardSession } from "./api";
import { ciColor, statusVisual, theme } from "./theme";
import { Dot } from "./ui";

export function SessionCard({ session, showProject = false }: { session: DashboardSession; showProject?: boolean }) {
	const router = useRouter();
	const v = statusVisual(session.status);
	const pr = session.pr ?? session.prs?.[0];
	const title = sessionTitle(session);

	return (
		<Pressable
			onPress={() =>
				router.push({
					pathname: "/session/[id]",
					params: { id: session.id, projectId: session.projectId },
				})
			}
			style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
		>
			<View style={styles.top}>
				<Dot color={v.color} breathing={v.breathing} size={8} />
				<Text style={[styles.status, { color: v.color }]}>{v.label}</Text>
				<View style={{ flex: 1 }} />
				{showProject ? <Text style={styles.project}>{session.projectId}</Text> : null}
				<Text style={styles.id}>{session.id}</Text>
			</View>

			<Text style={styles.title} numberOfLines={2}>
				{title}
			</Text>

			<View style={styles.meta}>
				{session.branch ? (
					<View style={styles.metaItem}>
						<Feather name="git-branch" size={11} color={theme.textTertiary} />
						<Text style={styles.branch} numberOfLines={1}>
							{session.branch}
						</Text>
					</View>
				) : null}
				{pr?.number ? (
					<View style={[styles.prChip, { borderColor: ciColor(pr.ciStatus) }]}>
						<Dot color={ciColor(pr.ciStatus)} size={6} />
						<Text style={styles.prText}>#{pr.number}</Text>
						{pr.additions !== undefined && pr.deletions !== undefined ? (
							<Text style={styles.diff}>
								<Text style={{ color: theme.green }}>+{pr.additions}</Text>{" "}
								<Text style={{ color: theme.red }}>-{pr.deletions}</Text>
							</Text>
						) : null}
					</View>
				) : null}
				<View style={{ flex: 1 }} />
				<Feather name="terminal" size={15} color={theme.textTertiary} />
			</View>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	card: {
		backgroundColor: theme.bgElevated,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		paddingHorizontal: 14,
		paddingVertical: 13,
		marginHorizontal: 12,
		marginVertical: 5,
	},
	cardPressed: { backgroundColor: theme.bgElevatedHover, borderColor: theme.borderDefault },
	top: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
	status: { fontSize: 12, fontWeight: "600" },
	project: {
		color: theme.textTertiary,
		fontSize: 11,
		fontFamily: theme.fontMono,
		marginRight: 8,
	},
	id: { color: theme.textTertiary, fontSize: 11, fontFamily: theme.fontMono },
	title: { color: theme.textPrimary, fontSize: 15, fontWeight: "500", lineHeight: 20 },
	meta: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 },
	metaItem: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
	branch: {
		color: theme.textTertiary,
		fontSize: 12,
		fontFamily: theme.fontMono,
		flexShrink: 1,
	},
	prChip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingHorizontal: 7,
		paddingVertical: 3,
		borderRadius: 6,
		borderWidth: 1,
	},
	prText: { color: theme.textSecondary, fontSize: 11, fontWeight: "700", fontFamily: theme.fontMono },
	diff: { fontSize: 10, fontFamily: theme.fontMono },
});
