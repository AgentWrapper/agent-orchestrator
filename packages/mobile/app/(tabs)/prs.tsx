import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DashboardPR, DashboardSession } from "../../lib/api";
import { isTerminalStatus } from "../../lib/api";
import { ProjectSwitcher } from "../../lib/ProjectSwitcher";
import { BoardColumn, CardGrid, WideContainer, useBreakpoint } from "../../lib/responsive";
import { useApp, usePRs, type PRDensity } from "../../lib/store";
import { ciVisual, theme } from "../../lib/theme";
import { Button, Chip, ConnectionPill, Dot, EmptyState, Pill, ScreenHeader } from "../../lib/ui";

type Filter = "open" | "merged" | "all";
type SortMode = "updated" | "ci" | "review";
type SectionId = "needs" | "ready" | "review" | "merged" | "dead";
type PRAction = "merge" | "close";
type PRItem = { pr: DashboardPR; session: DashboardSession };

type SectionDef = {
	id: SectionId;
	label: string;
	color: string;
	defaultCollapsed?: boolean;
};

const ACTIVE_SECTIONS: SectionDef[] = [
	{ id: "needs", label: "Needs you", color: theme.amber },
	{ id: "ready", label: "Ready to merge", color: theme.green },
	{ id: "review", label: "In review", color: theme.textTertiary },
];

const PASSIVE_SECTIONS: SectionDef[] = [
	{ id: "merged", label: "Merged", color: theme.green, defaultCollapsed: true },
	{ id: "dead", label: "Dead sessions", color: theme.textFaint, defaultCollapsed: true },
];

const FILTERS: Filter[] = ["open", "merged", "all"];
const SORTS: SortMode[] = ["updated", "ci", "review"];

export default function PRsScreen() {
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const wide = useBreakpoint() === "wide";
	const { configured, connection, refresh, prDensity, setPRDensity, merge, close } = useApp();
	const prs = usePRs();
	const [filter, setFilter] = useState<Filter>("open");
	const [sortMode, setSortMode] = useState<SortMode>("updated");
	const [search, setSearch] = useState("");
	const [refreshing, setRefreshing] = useState(false);
	const [optimisticStates, setOptimisticStates] = useState<Record<string, DashboardPR["state"]>>({});
	const [confirm, setConfirm] = useState<{ action: PRAction; item: PRItem } | null>(null);
	const [busy, setBusy] = useState<{ action: PRAction; key: string } | null>(null);
	const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);

	const items = useMemo<PRItem[]>(
		() =>
			prs.map(({ pr, session }) => ({
				session,
				pr: { ...pr, state: optimisticStates[prKey(pr, session)] ?? pr.state },
			})),
		[prs, optimisticStates],
	);

	const counts = useMemo(
		() => ({
			open: items.filter((item) => activePR(item.pr)).length,
			merged: items.filter((item) => item.pr.state === "merged").length,
			all: items.length,
		}),
		[items],
	);

	const grouped = useMemo(() => groupPRs(items, filter, search, sortMode), [items, filter, search, sortMode]);
	const hasResults = [...ACTIVE_SECTIONS, ...PASSIVE_SECTIONS].some((section) => grouped[section.id].length > 0);

	const onRefresh = async () => {
		setRefreshing(true);
		await refresh();
		setRefreshing(false);
	};

	const openSession = (session: DashboardSession) => {
		router.push({
			pathname: "/session/[id]",
			params: { id: session.id, projectId: session.projectId },
		});
	};

	const runConfirmedAction = async () => {
		if (!confirm) return;
		const { action, item } = confirm;
		const key = prKey(item.pr, item.session);
		setBusy({ action, key });
		setNotice(null);
		try {
			if (action === "merge") {
				await merge(item.pr);
				setOptimisticStates((current) => ({ ...current, [key]: "merged" }));
				setNotice({ kind: "success", text: `Merged #${item.pr.number}.` });
			} else {
				await close(item.pr);
				setOptimisticStates((current) => ({ ...current, [key]: "closed" }));
				setNotice({ kind: "success", text: `Closed #${item.pr.number}.` });
			}
			setConfirm(null);
			await refresh();
		} catch (error) {
			setConfirm(null);
			setNotice({
				kind: "error",
				text: error instanceof Error ? error.message : `${action === "merge" ? "Merge" : "Close"} failed`,
			});
		} finally {
			setBusy(null);
		}
	};

	if (!configured) {
		return (
			<View style={styles.screen}>
				<View style={{ height: insets.top }} />
				<EmptyState icon="git-pull-request" title="No server" message="Connect to AO in Settings." />
			</View>
		);
	}

	const filters = (
		<View style={styles.filters}>
			{FILTERS.map((f) => (
				<Pill key={f} label={`${labelForFilter(f)} ${counts[f]}`} active={filter === f} onPress={() => setFilter(f)} />
			))}
		</View>
	);

	const controls = (
		<View style={styles.controls}>
			<View style={styles.searchBox}>
				<Feather name="search" size={15} color={theme.textTertiary} />
				<TextInput
					value={search}
					onChangeText={setSearch}
					placeholder="Search repo, number, title"
					placeholderTextColor={theme.textFaint}
					style={styles.searchInput}
					autoCapitalize="none"
					autoCorrect={false}
				/>
				{search ? (
					<Pressable onPress={() => setSearch("")} hitSlop={8}>
						<Feather name="x" size={15} color={theme.textTertiary} />
					</Pressable>
				) : null}
			</View>
			<SegmentedControl
				label="Density"
				options={["cards", "table"]}
				value={prDensity}
				onChange={(value) => setPRDensity(value as PRDensity)}
			/>
			<SegmentedControl label="Sort" options={SORTS} value={sortMode} onChange={(value) => setSortMode(value)} />
		</View>
	);

	return (
		<View style={styles.screen}>
			<View style={{ height: insets.top }} />
			<ScreenHeader title="Pull Requests" right={<ConnectionPill status={connection} />} />
			<ProjectSwitcher />

			{wide ? (
				<WideContainer>
					{filters}
					{controls}
				</WideContainer>
			) : (
				<>
					{filters}
					{controls}
				</>
			)}

			{notice ? (
				<WideContainer>
					<Pressable
						onPress={() => setNotice(null)}
						style={[styles.notice, notice.kind === "error" ? styles.noticeError : styles.noticeSuccess]}
					>
						<Text
							style={[styles.noticeText, notice.kind === "error" ? styles.noticeErrorText : styles.noticeSuccessText]}
						>
							{notice.text}
						</Text>
						<Feather name="x" size={14} color={notice.kind === "error" ? theme.red : theme.green} />
					</Pressable>
				</WideContainer>
			) : null}

			<ScrollView
				contentContainerStyle={wide ? styles.wideScrollContent : styles.scrollContent}
				refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.blue} />}
			>
				{hasResults ? (
					<WideContainer style={styles.content}>
						{prDensity === "cards" && wide ? (
							<View style={styles.boardColumns}>
								{ACTIVE_SECTIONS.map((section) => (
									<BoardColumn
										key={section.id}
										label={section.label}
										color={section.color}
										count={grouped[section.id].length}
										contentContainerStyle={styles.boardColumnContent}
									>
										{grouped[section.id].length ? (
											<CardGrid cardBasis={320} maxCardWidth={520} gap={10}>
												{grouped[section.id].map((item) => (
													<PRCard
														key={prKey(item.pr, item.session)}
														item={item}
														busy={isBusy(busy, item)}
														onOpenSession={() => openSession(item.session)}
														onRequestAction={(action) => setConfirm({ action, item })}
													/>
												))}
											</CardGrid>
										) : (
											<EmptyLane label="No PRs" />
										)}
									</BoardColumn>
								))}
							</View>
						) : (
							ACTIVE_SECTIONS.map((section) => (
								<TriageSection key={section.id} section={section} count={grouped[section.id].length}>
									<SectionItems
										items={grouped[section.id]}
										density={prDensity}
										busy={busy}
										wide={wide}
										onOpenSession={openSession}
										onRequestAction={(action, item) => setConfirm({ action, item })}
									/>
								</TriageSection>
							))
						)}

						{PASSIVE_SECTIONS.map((section) =>
							grouped[section.id].length ? (
								<TriageSection
									key={section.id}
									section={section}
									count={grouped[section.id].length}
									defaultCollapsed={section.defaultCollapsed}
								>
									<SectionItems
										items={grouped[section.id]}
										density={prDensity}
										busy={busy}
										wide={wide}
										onOpenSession={openSession}
										onRequestAction={(action, item) => setConfirm({ action, item })}
									/>
								</TriageSection>
							) : null,
						)}
					</WideContainer>
				) : (
					<EmptyState
						icon="git-pull-request"
						title="No pull requests"
						message={
							search ? "No PRs match the search." : filter === "open" ? "No open PRs right now." : "Nothing here yet."
						}
					/>
				)}
			</ScrollView>

			<ConfirmDialog
				confirm={confirm}
				busy={!!busy}
				onCancel={() => (busy ? undefined : setConfirm(null))}
				onConfirm={() => void runConfirmedAction()}
			/>
		</View>
	);
}

function SectionItems({
	items,
	density,
	busy,
	wide,
	onOpenSession,
	onRequestAction,
}: {
	items: PRItem[];
	density: PRDensity;
	busy: { action: PRAction; key: string } | null;
	wide: boolean;
	onOpenSession: (session: DashboardSession) => void;
	onRequestAction: (action: PRAction, item: PRItem) => void;
}) {
	if (!items.length) return <EmptyLane label="No PRs" />;
	if (density === "table") {
		return (
			<View style={styles.table}>
				{items.map((item) => (
					<PRTableRow
						key={prKey(item.pr, item.session)}
						item={item}
						wide={wide}
						busy={isBusy(busy, item)}
						onOpenSession={() => onOpenSession(item.session)}
						onRequestAction={(action) => onRequestAction(action, item)}
					/>
				))}
			</View>
		);
	}
	return (
		<CardGrid cardBasis={400} maxCardWidth={520}>
			{items.map((item) => (
				<PRCard
					key={prKey(item.pr, item.session)}
					item={item}
					busy={isBusy(busy, item)}
					wide={wide}
					onOpenSession={() => onOpenSession(item.session)}
					onRequestAction={(action) => onRequestAction(action, item)}
				/>
			))}
		</CardGrid>
	);
}

function TriageSection({
	section,
	count,
	defaultCollapsed = false,
	children,
}: {
	section: SectionDef;
	count: number;
	defaultCollapsed?: boolean;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(defaultCollapsed);
	return (
		<View style={styles.section}>
			<Pressable
				accessibilityState={{ expanded: !collapsed }}
				onPress={() => setCollapsed((value) => !value)}
				style={({ pressed }) => [styles.sectionHeader, pressed && styles.sectionHeaderPressed]}
			>
				<Feather
					name="chevron-right"
					size={15}
					color={theme.textTertiary}
					style={[styles.sectionChevron, !collapsed && styles.sectionChevronOpen]}
				/>
				<Dot color={section.color} size={8} />
				<Text style={styles.sectionLabel}>{section.label.toUpperCase()}</Text>
				<Text style={styles.sectionCount}>{count}</Text>
			</Pressable>
			{collapsed ? null : <View style={styles.sectionBody}>{children}</View>}
		</View>
	);
}

function PRCard({
	item,
	wide,
	busy,
	onOpenSession,
	onRequestAction,
}: {
	item: PRItem;
	wide?: boolean;
	busy: boolean;
	onOpenSession: () => void;
	onRequestAction: (action: PRAction) => void;
}) {
	const { pr, session } = item;
	const ci = pr.ciStatus;
	const review = pr.reviewDecision;

	return (
		<View style={[styles.card, wide && styles.cardWide]}>
			<View style={styles.cardTop}>
				<Text style={styles.repo} numberOfLines={1}>
					{repoLabel(pr, session)}
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
				{prTitle(pr)}
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
				) : review === "pending" ? (
					<Chip label="review pending" color={theme.textSecondary} tint={theme.bgSubtle} icon="clock" />
				) : null}
				<DiffChip pr={pr} />
				<Chip label={formatAge(updatedAt(item))} color={theme.textTertiary} tint={theme.bgSubtle} mono icon="clock" />
				{pr.unresolvedThreads ? (
					<Chip
						label={`${pr.unresolvedThreads} threads`}
						color={theme.amber}
						tint={theme.tintAmber}
						icon="message-square"
					/>
				) : null}
			</View>

			<PRActions item={item} busy={busy} wide={wide} onOpenSession={onOpenSession} onRequestAction={onRequestAction} />
		</View>
	);
}

function PRTableRow({
	item,
	wide,
	busy,
	onOpenSession,
	onRequestAction,
}: {
	item: PRItem;
	wide: boolean;
	busy: boolean;
	onOpenSession: () => void;
	onRequestAction: (action: PRAction) => void;
}) {
	const { pr, session } = item;
	const c = ciVisual(pr.ciStatus);
	return (
		<View style={[styles.tableRow, wide && styles.tableRowWide]}>
			<View style={wide ? styles.tableRepoCell : styles.tablePhoneLine}>
				<Text style={styles.tableRepo} numberOfLines={1}>
					{repoLabel(pr, session)}
				</Text>
				<Text style={styles.tableNumber}>#{pr.number}</Text>
			</View>
			<Text style={[styles.tableTitle, wide && styles.tableTitleWide]} numberOfLines={wide ? 1 : 2}>
				{prTitle(pr)}
			</Text>
			<View style={styles.tableMeta}>
				<Chip label={c.label.replace("CI ", "")} color={c.color} tint={c.tint} icon={c.icon} />
				<Chip
					label={reviewLabel(pr.reviewDecision)}
					color={reviewColor(pr.reviewDecision)}
					tint={reviewTint(pr.reviewDecision)}
				/>
				<Text style={styles.tableDiff}>{diffLabel(pr)}</Text>
				<Text style={styles.tableAge}>{formatAge(updatedAt(item))}</Text>
			</View>
			<PRActions
				item={item}
				busy={busy}
				wide={wide}
				compact
				onOpenSession={onOpenSession}
				onRequestAction={onRequestAction}
			/>
		</View>
	);
}

function PRActions({
	item,
	busy,
	wide,
	compact,
	onOpenSession,
	onRequestAction,
}: {
	item: PRItem;
	busy: boolean;
	wide?: boolean;
	compact?: boolean;
	onOpenSession: () => void;
	onRequestAction: (action: PRAction) => void;
}) {
	const { pr } = item;
	const canAct = activePR(pr);
	const canMerge = canAct && pr.mergeability?.mergeable === true;
	return (
		<View style={[styles.actions, compact && styles.tableActions, wide && styles.actionsWide]}>
			{canMerge ? (
				<Button
					title="Merge"
					icon="git-merge"
					onPress={() => onRequestAction("merge")}
					loading={busy}
					disabled={busy}
					style={compact ? styles.compactActionBtn : styles.actionBtn}
				/>
			) : null}
			{canAct ? (
				<Button
					title="Close"
					variant="danger"
					icon="x-circle"
					onPress={() => onRequestAction("close")}
					disabled={busy}
					style={compact ? styles.compactActionBtn : styles.actionBtn}
				/>
			) : null}
			<Button
				title="Session"
				variant="ghost"
				icon="terminal"
				onPress={onOpenSession}
				disabled={busy}
				style={compact ? styles.compactActionBtn : styles.actionBtn}
			/>
			{pr.url ? (
				<Button
					title="GitHub"
					variant="ghost"
					icon="external-link"
					onPress={() => Linking.openURL(pr.url)}
					disabled={busy}
					style={compact ? styles.compactActionBtn : styles.actionBtn}
				/>
			) : null}
		</View>
	);
}

function ConfirmDialog({
	confirm,
	busy,
	onCancel,
	onConfirm,
}: {
	confirm: { action: PRAction; item: PRItem } | null;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const pr = confirm?.item.pr;
	const action = confirm?.action;
	if (!confirm) return null;
	return (
		<View style={styles.modalOverlay}>
			<View style={styles.modalCard}>
				<Text style={styles.modalTitle}>
					{action === "merge" ? `Squash-merge #${pr?.number}?` : `Close #${pr?.number}?`}
				</Text>
				<Text style={styles.modalText}>
					{action === "merge"
						? "AO will ask the daemon to squash-merge this pull request."
						: "AO will ask the daemon to close this pull request without merging it."}
				</Text>
				<View style={styles.modalActions}>
					<Button title="Cancel" variant="ghost" onPress={onCancel} disabled={busy} style={styles.modalBtn} />
					<Button
						title={action === "merge" ? "Merge" : "Close"}
						variant={action === "close" ? "danger" : "primary"}
						onPress={onConfirm}
						loading={busy}
						disabled={busy}
						style={styles.modalBtn}
					/>
				</View>
			</View>
		</View>
	);
}

function SegmentedControl<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly T[];
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<View style={styles.segmentGroup}>
			<Text style={styles.segmentLabel}>{label}</Text>
			<View style={styles.segmentOptions}>
				{options.map((option) => (
					<Pill
						key={option}
						label={labelForOption(option)}
						active={value === option}
						onPress={() => onChange(option)}
						style={styles.segmentPill}
						textStyle={styles.segmentPillText}
					/>
				))}
			</View>
		</View>
	);
}

function DiffChip({ pr }: { pr: DashboardPR }) {
	if (pr.additions === undefined && pr.deletions === undefined) return null;
	return (
		<View style={styles.diffChip}>
			<Text style={[styles.diffText, { color: theme.green }]}>+{pr.additions ?? 0}</Text>
			<Text style={[styles.diffText, { color: theme.red }]}>-{pr.deletions ?? 0}</Text>
		</View>
	);
}

function EmptyLane({ label }: { label: string }) {
	return <Text style={styles.emptyLane}>{label}</Text>;
}

function groupPRs(items: PRItem[], filter: Filter, search: string, sortMode: SortMode): Record<SectionId, PRItem[]> {
	const groups: Record<SectionId, PRItem[]> = {
		needs: [],
		ready: [],
		review: [],
		merged: [],
		dead: [],
	};
	const query = search.trim().toLowerCase();
	for (const item of items) {
		if (!passesFilter(item.pr, filter) || !matchesSearch(item, query)) continue;
		if (isTerminalStatus(item.session.status)) {
			groups.dead.push(item);
			continue;
		}
		const section = classifyPR(item.pr);
		if (section) groups[section].push(item);
	}
	for (const section of Object.keys(groups) as SectionId[]) {
		groups[section].sort((a, b) => compareItems(a, b, sortMode));
	}
	return groups;
}

function classifyPR(pr: DashboardPR): Exclude<SectionId, "dead"> | null {
	if (pr.state === "merged") return "merged";
	if (!activePR(pr)) return null;
	if (pr.ciStatus === "failing" || pr.reviewDecision === "changes_requested") return "needs";
	if (pr.reviewDecision === "approved" && pr.ciStatus === "passing" && pr.mergeability?.mergeable) return "ready";
	return "review";
}

function passesFilter(pr: DashboardPR, filter: Filter): boolean {
	if (filter === "all") return true;
	if (filter === "merged") return pr.state === "merged";
	return activePR(pr);
}

function matchesSearch(item: PRItem, query: string): boolean {
	if (!query) return true;
	const pr = item.pr;
	return [repoLabel(pr, item.session), `#${pr.number}`, String(pr.number), pr.title ?? ""].some((value) =>
		value.toLowerCase().includes(query),
	);
}

function compareItems(a: PRItem, b: PRItem, sortMode: SortMode): number {
	if (sortMode === "ci") {
		const byCI = ciRank(a.pr.ciStatus) - ciRank(b.pr.ciStatus);
		if (byCI !== 0) return byCI;
	}
	if (sortMode === "review") {
		const byReview = reviewRank(a.pr.reviewDecision) - reviewRank(b.pr.reviewDecision);
		if (byReview !== 0) return byReview;
	}
	return updatedMs(b) - updatedMs(a) || a.pr.number - b.pr.number;
}

function ciRank(ci?: DashboardPR["ciStatus"]): number {
	if (ci === "failing") return 0;
	if (ci === "pending") return 1;
	if (ci === "passing") return 2;
	return 3;
}

function reviewRank(review?: DashboardPR["reviewDecision"]): number {
	if (review === "changes_requested") return 0;
	if (review === "pending") return 1;
	if (review === "approved") return 2;
	return 3;
}

function activePR(pr: DashboardPR): boolean {
	return (pr.state ?? "open") === "open";
}

function isBusy(busy: { action: PRAction; key: string } | null, item: PRItem): boolean {
	return busy?.key === prKey(item.pr, item.session);
}

function prKey(pr: DashboardPR, session: DashboardSession): string {
	return `${pr.owner ?? ""}/${pr.repo ?? session.projectId}#${pr.number}`;
}

function repoLabel(pr: DashboardPR, session: DashboardSession): string {
	if (pr.owner && pr.repo) return `${pr.owner}/${pr.repo}`;
	return pr.repo || session.projectId;
}

function prTitle(pr: DashboardPR): string {
	return pr.title ?? `Pull request #${pr.number}`;
}

function updatedAt(item: PRItem): string | undefined {
	return item.pr.updatedAt || item.session.lastActivityAt || item.session.createdAt || undefined;
}

function updatedMs(item: PRItem): number {
	const raw = updatedAt(item);
	const value = raw ? Date.parse(raw) : Number.NaN;
	return Number.isFinite(value) ? value : 0;
}

function formatAge(raw?: string): string {
	const value = raw ? Date.parse(raw) : Number.NaN;
	if (!Number.isFinite(value)) return "age n/a";
	const diff = Math.max(0, Date.now() - value);
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) return `${Math.max(1, minutes)}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 14) return `${days}d`;
	return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function diffLabel(pr: DashboardPR): string {
	if (pr.additions === undefined && pr.deletions === undefined) return "+0/-0";
	return `+${pr.additions ?? 0}/-${pr.deletions ?? 0}`;
}

function reviewLabel(review?: DashboardPR["reviewDecision"]): string {
	if (review === "approved") return "approved";
	if (review === "changes_requested") return "changes";
	if (review === "pending") return "pending";
	return "none";
}

function reviewColor(review?: DashboardPR["reviewDecision"]): string {
	if (review === "approved") return theme.green;
	if (review === "changes_requested") return theme.amber;
	return theme.textSecondary;
}

function reviewTint(review?: DashboardPR["reviewDecision"]): string {
	if (review === "approved") return theme.tintGreen;
	if (review === "changes_requested") return theme.tintAmber;
	return theme.bgSubtle;
}

function labelForFilter(filter: Filter): string {
	if (filter === "open") return "Open";
	if (filter === "merged") return "Merged";
	return "All";
}

function labelForOption(option: string): string {
	return option[0].toUpperCase() + option.slice(1);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: theme.bgBase },
	filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
	controls: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 10,
		paddingHorizontal: 16,
		paddingBottom: 12,
		alignItems: "center",
	},
	searchBox: {
		minWidth: 240,
		flex: 1,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		backgroundColor: theme.bgElevated,
		paddingHorizontal: 11,
		height: 38,
	},
	searchInput: {
		flex: 1,
		color: theme.textPrimary,
		fontSize: 13,
		padding: 0,
	},
	segmentGroup: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
	segmentLabel: {
		color: theme.textTertiary,
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 1,
		textTransform: "uppercase",
	},
	segmentOptions: { flexDirection: "row", gap: 6 },
	segmentPill: { paddingHorizontal: 10, paddingVertical: 6 },
	segmentPillText: { fontSize: 12 },
	notice: {
		marginHorizontal: 16,
		marginBottom: 10,
		borderRadius: 10,
		borderWidth: 1,
		paddingHorizontal: 12,
		paddingVertical: 9,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	noticeError: { borderColor: theme.tintRed, backgroundColor: theme.tintRed },
	noticeSuccess: { borderColor: theme.tintGreen, backgroundColor: theme.tintGreen },
	noticeText: { flex: 1, fontSize: 12, fontWeight: "600" },
	noticeErrorText: { color: theme.red },
	noticeSuccessText: { color: theme.green },
	scrollContent: { paddingBottom: 110, paddingTop: 2 },
	wideScrollContent: { paddingBottom: 110, paddingTop: 6 },
	content: { paddingHorizontal: 16, gap: 12 },
	boardColumns: { flexDirection: "row", gap: 12, minHeight: 460 },
	boardColumnContent: { paddingHorizontal: 10, paddingBottom: 12 },
	section: {
		borderRadius: 13,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		backgroundColor: theme.bgColumn,
		overflow: "hidden",
	},
	sectionHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 9,
		paddingHorizontal: 14,
		paddingTop: 14,
		paddingBottom: 12,
	},
	sectionHeaderPressed: { backgroundColor: theme.bgSubtle },
	sectionChevron: { transform: [{ rotate: "0deg" }] },
	sectionChevronOpen: { transform: [{ rotate: "90deg" }] },
	sectionLabel: {
		flex: 1,
		color: theme.textSecondary,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.2,
	},
	sectionCount: {
		color: theme.textTertiary,
		fontSize: 12,
		fontWeight: "700",
		fontFamily: theme.fontMono,
	},
	sectionBody: { paddingHorizontal: 10, paddingBottom: 12 },
	card: {
		backgroundColor: theme.bgElevated,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		padding: 14,
		marginHorizontal: 0,
		marginVertical: 0,
	},
	cardWide: { width: "100%" },
	cardTop: { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
	repo: { color: theme.textTertiary, fontSize: 12, fontFamily: theme.fontMono, minWidth: 0, flexShrink: 1 },
	num: { color: theme.textSecondary, fontSize: 13, fontWeight: "700", fontFamily: theme.fontMono },
	title: { color: theme.textPrimary, fontSize: 15, fontWeight: "600", lineHeight: 20 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
	diffChip: { flexDirection: "row", gap: 6, alignItems: "center", paddingHorizontal: 4 },
	diffText: { fontSize: 11, fontWeight: "700", fontFamily: theme.fontMono },
	actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
	actionsWide: { justifyContent: "flex-start" },
	actionBtn: { flexGrow: 1, flexBasis: 112, paddingVertical: 10 },
	compactActionBtn: { paddingVertical: 8, paddingHorizontal: 10 },
	table: { gap: 8 },
	tableRow: {
		borderRadius: 8,
		borderWidth: 1,
		borderColor: theme.borderSubtle,
		backgroundColor: theme.bgElevated,
		paddingHorizontal: 11,
		paddingVertical: 10,
		gap: 8,
	},
	tableRowWide: { flexDirection: "row", alignItems: "center", gap: 10 },
	tableRepoCell: { width: 190, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
	tablePhoneLine: { flexDirection: "row", alignItems: "center", gap: 8 },
	tableRepo: { color: theme.textTertiary, fontSize: 11, fontFamily: theme.fontMono, flexShrink: 1 },
	tableNumber: { color: theme.textSecondary, fontSize: 12, fontWeight: "700", fontFamily: theme.fontMono },
	tableTitle: { color: theme.textPrimary, fontSize: 13, fontWeight: "600", lineHeight: 18 },
	tableTitleWide: { flex: 1, minWidth: 160 },
	tableMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
	tableDiff: { color: theme.textTertiary, fontSize: 11, fontWeight: "700", fontFamily: theme.fontMono },
	tableAge: { color: theme.textTertiary, fontSize: 11, fontWeight: "700", fontFamily: theme.fontMono },
	tableActions: { marginTop: 0 },
	emptyLane: {
		color: theme.textTertiary,
		fontSize: 12,
		textAlign: "center",
		paddingVertical: 18,
	},
	modalOverlay: {
		...StyleSheet.absoluteFillObject,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0,0,0,0.58)",
		padding: 20,
		zIndex: 20,
		elevation: 20,
	},
	modalCard: {
		width: "100%",
		maxWidth: 380,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: theme.borderDefault,
		backgroundColor: theme.bgElevated,
		padding: 16,
	},
	modalTitle: { color: theme.textPrimary, fontSize: 18, fontWeight: "800" },
	modalText: { color: theme.textSecondary, fontSize: 13, lineHeight: 20, marginTop: 8 },
	modalActions: { flexDirection: "row", gap: 10, marginTop: 16 },
	modalBtn: { flex: 1 },
});
