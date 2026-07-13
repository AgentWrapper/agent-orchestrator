import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DashboardPR, DashboardSession } from "../../lib/api";
import { haptics } from "../../lib/haptics";
import { ProjectSwitcher } from "../../lib/ProjectSwitcher";
import { useApp, usePRs } from "../../lib/store";
import { ciVisual, theme } from "../../lib/theme";
import { Button, Chip, ConnectionPill, EmptyState, Pill, ScreenHeader } from "../../lib/ui";

type Filter = "open" | "merged" | "all";

export default function PRsScreen() {
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const { configured, connection, refresh } = useApp();
	const prs = usePRs();
	const [filter, setFilter] = useState<Filter>("open");
	const [refreshing, setRefreshing] = useState(false);

	const filtered = useMemo(() => {
		return prs.filter(({ pr }) => {
			const st = pr.state ?? "open";
			if (filter === "all") return true;
			if (filter === "open") return st === "open";
			return st === "merged";
		});
	}, [prs, filter]);

	const onRefresh = async () => {
		haptics.tap();
		setRefreshing(true);
		await refresh();
		setRefreshing(false);
	};

	if (!configured) {
		return (
			<View style={styles.screen}>
				<View style={{ height: insets.top }} />
				<EmptyState icon="git-pull-request" title="No server" message="Connect to AO in Settings." />
			</View>
		);
	}

	const counts = {
		open: prs.filter((p) => (p.pr.state ?? "open") === "open").length,
		merged: prs.filter((p) => p.pr.state === "merged").length,
		all: prs.length,
	};

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader title="Pull Requests" right={<ConnectionPill status={connection} />} />
			<ProjectSwitcher />

			<View style={styles.filters}>
				{(["open", "merged", "all"] as Filter[]).map((f) => (
					<Pill
						key={f}
						label={`${f[0].toUpperCase() + f.slice(1)} ${counts[f]}`}
						active={filter === f}
						onPress={() => setFilter(f)}
					/>
				))}
			</View>

			<ScrollView
				contentContainerStyle={{ paddingBottom: 110, paddingTop: 4 }}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.blue} />}
			>
				{filtered.length === 0 ? (
					<EmptyState
						icon="git-pull-request"
						title="No pull requests"
						message={filter === "open" ? "No open PRs right now." : "Nothing here yet."}
					/>
				) : (
					filtered.map(({ pr, session }) => (
						<PRCard
							key={`${pr.owner}/${pr.repo}#${pr.number}`}
							pr={pr}
							session={session}
							onOpenSession={() =>
								router.push({
									pathname: "/session/[id]",
									params: { id: session.id, projectId: session.projectId },
								})
							}
						/>
					))
				)}
			</ScrollView>
		</View>
	);
}

function PRCard({
	pr,
	session,
	onOpenSession,
}: {
	pr: DashboardPR;
	session: DashboardSession;
	onOpenSession: () => void;
}) {
	const ci = pr.ciStatus;
	const review = pr.reviewDecision;

	return (
		<View style={styles.card}>
			<View style={styles.cardTop}>
				<Text style={styles.repo} numberOfLines={1}>
					{pr.repo ? `${pr.owner}/${pr.repo}` : session.projectId}
				</Text>
				<View style={{ flex: 1 }} />
				{pr.state === "merged" ? (
					<Chip label="merged" color={theme.green} tint={theme.tintGreen} icon="git-merge" />
				) : pr.state === "closed" ? (
					<Chip label="closed" color={theme.red} tint={theme.tintRed} />
				) : (
					<Text style={styles.num}>#{pr.number}</Text>
				)}
			</View>

			<Text style={styles.title} numberOfLines={2}>
				{pr.title ?? `Pull request #${pr.number}`}
			</Text>

			<View style={styles.chips}>
				{ci && ci !== "none"
					? (() => {
							const c = ciVisual(ci);
							return <Chip label={c.label} color={c.color} tint={c.tint} icon={c.icon} />;
						})()
					: null}
				{review === "approved" ? (
					<Chip label="approved" color={theme.green} tint={theme.tintGreen} icon="check" />
				) : review === "changes_requested" ? (
					<Chip label="changes req." color={theme.amber} tint={theme.tintAmber} icon="edit-3" />
				) : null}
				{pr.additions !== undefined && pr.deletions !== undefined ? (
					<View style={styles.diffChip}>
						<Text style={[styles.diffText, { color: theme.green }]}>+{pr.additions}</Text>
						<Text style={[styles.diffText, { color: theme.red }]}>-{pr.deletions}</Text>
					</View>
				) : null}
				{pr.unresolvedThreads ? (
					<Chip
						label={`${pr.unresolvedThreads} threads`}
						color={theme.amber}
						tint={theme.tintAmber}
						icon="message-square"
					/>
				) : null}
			</View>

			<View style={styles.actions}>
				<Button title="Session" variant="ghost" icon="terminal" onPress={onOpenSession} style={styles.flexBtn} />
				{pr.url ? (
					<Button
						title="Open"
						variant="ghost"
						icon="external-link"
						onPress={() => Linking.openURL(pr.url!)}
						style={styles.flexBtn}
					/>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
	card: {
		backgroundColor: theme.bgElevated,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		padding: 14,
		marginHorizontal: 12,
		marginVertical: 5,
	},
	cardTop: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
	repo: { color: theme.textTertiary, fontSize: 12, fontFamily: theme.fontMono },
	num: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", fontFamily: theme.fontMono },
	title: { color: theme.textPrimary, fontSize: 15, fontWeight: "500", lineHeight: 20 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
	diffChip: { flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 4 },
	diffText: { fontSize: 11, fontWeight: "700", fontFamily: theme.fontMono },
	actions: { flexDirection: "row", gap: 8, marginTop: 14 },
	flexBtn: { flex: 1, paddingVertical: 10 },
});
