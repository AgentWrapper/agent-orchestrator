import { useMemo, useState } from "react";
import { ActivityIndicator, Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Theme } from "../../lib/theme";
import { classifyConnectionFailure, describeConnectionFailure } from "../../lib/connectionError";
import { haptics } from "../../lib/haptics";
import { PRCard } from "../../lib/PRCard";
import { ProjectSwitcher } from "../../lib/ProjectSwitcher";
import { comparePRs, prLifecycle } from "../../lib/prView";
import { useApp, usePRs } from "../../lib/store";
import { usePRSummaries } from "../../lib/usePRSummaries";
import { useTabScrollToTop } from "../../lib/useTabScrollToTop";
import { Button, EmptyState, Pill, ScreenHeader } from "../../lib/ui";
import { useTheme, useThemedStyles } from "../../lib/ThemeProvider";
import { useT } from "../../lib/i18n";

type Filter = "open" | "merged" | "all";

// Drafts are open PRs — they belong in the Open bucket even though the card
// labels them "draft". Before, `state` had already folded draft into "open", so
// the distinction did not exist anywhere.
const inBucket = (filter: Filter, life: ReturnType<typeof prLifecycle>) => {
	if (filter === "all") return true;
	if (filter === "open") return life === "open" || life === "draft";
	return life === "merged";
};

export default function PRsScreen() {
	const t = useTheme();
	const tr = useT();
	const styles = useThemedStyles(makeStyles);
	const insets = useSafeAreaInsets();
	const { configured, loading, error, errorStatus, connection, config, refresh } = useApp();
	const prs = usePRs();
	const [filter, setFilter] = useState<Filter>("open");
	const [refreshing, setRefreshing] = useState(false);

	const scrollRef = useTabScrollToTop<ScrollView>();

	// Sorted, which this list never was — PRs arrived in whatever order the
	// daemon returned them, so the one you could act on could be anywhere.
	const filtered = useMemo(
		() => prs.filter(({ pr }) => inBucket(filter, prLifecycle(pr))).sort((a, b) => comparePRs(a.pr, b.pr)),
		[prs, filter],
	);

	// The rich per-PR detail the cards show lives on a separate endpoint, fetched
	// once per session and cached — see usePRSummaries. Pull-to-refresh is the
	// only thing that re-fetches it.
	const sessionIds = useMemo(() => [...new Set(filtered.map(({ session }) => session.id))], [filtered]);
	const summaries = usePRSummaries(sessionIds);
	const failure = useMemo(
		() =>
			describeConnectionFailure(
				classifyConnectionFailure(errorStatus ?? undefined),
				{
					host: config?.host ?? "",
					port: config?.httpPort ?? "",
					platform: Platform.OS,
				},
				tr,
			),
		[errorStatus, config?.host, config?.httpPort, tr],
	);

	const onRefresh = async () => {
		haptics.tap();
		setRefreshing(true);
		summaries.reload();
		await refresh();
		setRefreshing(false);
	};

	if (!configured) {
		return (
			<View style={styles.screen}>
				<View style={{ height: insets.top }} />
				<EmptyState icon="git-pull-request" title={tr("common.noServer")} message={tr("common.connectInSettings")} />
			</View>
		);
	}

	const counts = {
		open: prs.filter((p) => inBucket("open", prLifecycle(p.pr))).length,
		merged: prs.filter((p) => prLifecycle(p.pr) === "merged").length,
		all: prs.length,
	};

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader title={tr("prs.title")} status={connection} />
			<ProjectSwitcher />

			<View style={styles.filters}>
				{(["open", "merged", "all"] as Filter[]).map((f) => (
					<Pill
						key={f}
						label={
							f === "open"
								? tr("prs.filterOpen", { count: counts.open })
								: f === "merged"
									? tr("prs.filterMerged", { count: counts.merged })
									: tr("prs.filterAll", { count: counts.all })
						}
						active={filter === f}
						onPress={() => setFilter(f)}
					/>
				))}
			</View>

			{loading && prs.length === 0 ? (
				<View style={styles.center}>
					<ActivityIndicator color={t.blue} />
				</View>
			) : (
				<ScrollView
					ref={scrollRef}
					contentContainerStyle={{ paddingBottom: 110, paddingTop: 4 }}
					refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.blue} />}
				>
					{filtered.length === 0 ? (
						error ? (
							<EmptyState
								icon="wifi-off"
								title={failure.title}
								message={failure.message}
								action={<Button title={tr("common.retry")} icon="refresh-cw" variant="ghost" onPress={onRefresh} />}
							/>
						) : (
							<EmptyState
								icon="git-pull-request"
								title={tr("prs.empty")}
								message={filter === "open" ? tr("prs.emptyOpen") : tr("prs.emptyOther")}
							/>
						)
					) : (
						filtered.map(({ pr, session }) => (
							<PRCard
								key={`${session.projectId}#${pr.number}`}
								pr={pr}
								session={session}
								summary={summaries.summaryFor(session.id, pr.number)}
							/>
						))
					)}
				</ScrollView>
			)}
		</View>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
		screen: { flex: 1, backgroundColor: t.bgBase },
		center: { flex: 1, alignItems: "center", justifyContent: "center" },
		filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
	});
