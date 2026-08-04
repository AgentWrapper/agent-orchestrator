import { Feather } from "@expo/vector-icons";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import type { DashboardSession, OrchestratorLink } from "../api";
import { haptics } from "../haptics";
import { useApp } from "../store";
import type { Theme } from "../theme";
import { useTheme, useThemedStyles } from "../ThemeProvider";
import { getWorkspacePaths, openSessionShell } from "./api";
import { ChatComposer } from "./ChatComposer";
import { ChatSettingsModal } from "./ChatSettingsModal";
import { ChatTimeline } from "./ChatTimeline";
import { brokenMcpServers, can } from "./types";
import { useMobileConversation } from "./useConversation";

type MobileChatSession = DashboardSession | OrchestratorLink;

export function ChatSessionScreen({ session }: { session: MobileChatSession }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const navigation = useNavigation();
	const router = useRouter();
	const { config, restore, setActiveProject } = useApp();
	const conversation = useMobileConversation(config, session.id);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [filePathsTruncated, setFilePathsTruncated] = useState(false);
	const [openingShell, setOpeningShell] = useState(false);
	const [resuming, setResuming] = useState(false);

	const title = conversation.snapshot?.title || sessionTitle(session);
	useLayoutEffect(() => {
		navigation.setOptions({
			title: title.length > 24 ? `${title.slice(0, 22)}…` : title,
			headerRight: () => (
				<Pressable accessibilityRole="button" accessibilityLabel="Conversation actions" hitSlop={11} onPress={() => setMenuOpen(true)} style={styles.headerAction}>
					<Feather name="more-horizontal" size={20} color={t.textSecondary} />
				</Pressable>
			),
		});
	}, [navigation, title, styles, t]);

	useEffect(() => {
		if (!config || !conversation.snapshot) return;
		let cancelled = false;
		const load = () => void getWorkspacePaths(config, session.id).then((result) => { if (!cancelled) { setFilePaths(result.paths); setFilePathsTruncated(result.truncated); } }).catch(() => {});
		load();
		const poll = setInterval(load, 30_000);
		return () => { cancelled = true; clearInterval(poll); };
	}, [config, session.id, conversation.snapshot?.conversationId]);

	const openShell = useCallback(async () => {
		if (!config || openingShell) return;
		setOpeningShell(true);
		try {
			const shell = await openSessionShell(config, session.id, session.projectId);
			setMenuOpen(false);
			router.push({ pathname: "/shell/[handleId]", params: { handleId: shell.handleId, projectId: session.projectId, sessionId: session.id, title: shell.title } });
		} catch (cause) {
			Alert.alert("Could not open shell", cause instanceof Error ? cause.message : String(cause));
		} finally { setOpeningShell(false); }
	}, [config, openingShell, router, session.id, session.projectId]);

	const resume = useCallback(async () => {
		if (resuming) return;
		setResuming(true);
		try {
			await restore(session.id);
			await conversation.refresh();
		} catch (cause) {
			Alert.alert("Could not resume agent", cause instanceof Error ? cause.message : String(cause));
		} finally { setResuming(false); }
	}, [conversation.refresh, restore, resuming, session.id]);

	if (conversation.loading && !conversation.snapshot) return <Centered icon="message-square" title="Loading conversation…" spinning />;
	if (conversation.unavailable) return <Unavailable message={conversation.unavailable.message} onShell={() => void openShell()} openingShell={openingShell} />;
	if (!conversation.snapshot) return <Centered icon="alert-triangle" title="Could not load conversation" message={conversation.error || "The daemon did not return a conversation."} action="Retry" onAction={() => void conversation.refresh()} />;

	const snapshot = conversation.snapshot;
	const active = snapshot.turns.some((turn) => turn.state === "running" || turn.state === "queued");
	const brokenServers = brokenMcpServers(snapshot);
	const rolledBack = snapshot.turns.filter((turn) => turn.rolledBack).length;

	return (
		<KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 86 : 0}>
			<ChatMetaBar snapshot={snapshot} refreshing={conversation.refreshing} onRefresh={() => void conversation.refresh()} />
			<ConversationBanners
				snapshot={snapshot}
				brokenServers={brokenServers}
				resuming={resuming}
				turnInFlight={active}
				onResume={() => void resume()}
				onReload={() => void conversation.reloadMcp().catch(() => {})}
				onOpenShell={() => void openShell()}
			/>
			{conversation.error ? <InlineBanner tone="danger" icon="wifi-off" text={conversation.error} action="Retry" onPress={() => void conversation.refresh()} /> : null}
			{conversation.actionError ? <InlineBanner tone="danger" icon="alert-circle" text={conversation.actionError} /> : null}
			{rolledBack ? <InlineBanner tone="muted" icon="rotate-ccw" text={`${rolledBack} ${rolledBack === 1 ? "turn was" : "turns were"} rolled back. The agent no longer remembers ${rolledBack === 1 ? "it" : "them"}.`} /> : null}
			{conversation.pendingSends.map((pendingSend) => pendingSend.state === "failed" ? <InlineBanner key={pendingSend.id} tone="danger" icon="send" text={`Message not sent: ${pendingSend.error || "Delivery failed"}`} action="Retry" secondary="Discard" onPress={() => void conversation.retrySend(pendingSend.id).catch(() => {})} onSecondary={() => conversation.discardSend(pendingSend.id)} /> : null)}
			<ChatTimeline
				snapshot={snapshot}
				loadingOlder={conversation.loadingOlder}
				onLoadOlder={() => void conversation.loadOlder()}
				actionPending={conversation.actionPending}
				onDecide={(requestId, decisionId) => void conversation.resolveApproval(requestId, decisionId).catch(() => {})}
				onResolveInput={(requestId, action, content) => void conversation.resolveInput(requestId, action, content).catch(() => {})}
				onRollback={(turnId) => void conversation.rollback(turnId).catch(() => {})}
			/>
			{active ? <LiveTurnBar snapshot={snapshot} stopping={conversation.actionPending} onInterrupt={() => void conversation.interrupt().catch(() => {})} /> : null}
			<ChatComposer
				sessionId={session.id}
				snapshot={snapshot}
				skills={conversation.skills}
				filePaths={filePaths}
				filePathsTruncated={filePathsTruncated}
				configOptions={conversation.configOptions}
				pending={conversation.pendingSends.some((item) => item.state === "sending")}
				error={conversation.actionError}
				onSend={conversation.send}
				onSteer={conversation.steer}
				onInterrupt={() => void conversation.interrupt().catch(() => {})}
				onOpenSettings={() => setSettingsOpen(true)}
			/>
			<ChatSettingsModal
				visible={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				snapshot={snapshot}
				models={conversation.models}
				options={conversation.configOptions}
				disabled={snapshot.controller.state === "stopped" || conversation.actionPending}
				onSettings={(settings) => void conversation.chooseSettings(settings).catch(() => {})}
				onOption={(id, value) => void conversation.setConfigOption(id, value).catch(() => {})}
			/>
			<ConversationMenu
				visible={menuOpen}
				onClose={() => setMenuOpen(false)}
				snapshot={snapshot}
				openingShell={openingShell}
				onOpenShell={() => void openShell()}
				onPreview={() => { setMenuOpen(false); router.push({ pathname: "/preview/[id]", params: { id: session.id, title } }); }}
				onPullRequests={() => { setMenuOpen(false); setActiveProject(session.projectId); router.push("/(tabs)/prs"); }}
				onSettings={() => { setMenuOpen(false); setSettingsOpen(true); }}
				onCompact={() => { setMenuOpen(false); void conversation.compact().catch(() => {}); }}
				onReload={() => { setMenuOpen(false); void conversation.reloadMcp().catch(() => {}); }}
				onRename={(next) => { setMenuOpen(false); void conversation.rename(next).catch(() => {}); }}
			/>
		</KeyboardAvoidingView>
	);
}

function ChatMetaBar({ snapshot, refreshing, onRefresh }: { snapshot: NonNullable<ReturnType<typeof useMobileConversation>["snapshot"]>; refreshing: boolean; onRefresh(): void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const state = snapshot.controller.state;
	const used = snapshot.usage?.contextUsed ?? 0;
	const window = snapshot.usage?.contextWindow ?? 0;
	const percent = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : undefined;
	const stateColor = state === "busy" ? t.orange : state === "ready" ? t.green : state === "stopped" ? t.red : t.amber;
	return <View style={styles.meta}><View style={[styles.dot, { backgroundColor: stateColor }]} /><Text style={styles.harness}>{snapshot.harness || "agent"}</Text><Text style={styles.mode}>CHAT</Text><View style={{ flex: 1 }} />{percent !== undefined ? <View accessibilityLabel={`${percent}% of context used`} style={styles.usage}><View style={[styles.usageFill, { width: `${percent}%` }]} /></View> : null}{percent !== undefined ? <Text style={styles.percent}>{percent}%</Text> : snapshot.usage ? <Text style={styles.percent}>{formatTokens(snapshot.usage.totalTokens)} tokens</Text> : null}<Pressable accessibilityRole="button" accessibilityLabel="Refresh conversation" hitSlop={9} onPress={onRefresh}><Feather name="refresh-cw" size={13} color={t.textTertiary} style={refreshing ? { opacity: 0.4 } : undefined} /></Pressable></View>;
}

function ConversationBanners({ snapshot, brokenServers, resuming, turnInFlight, onResume, onReload, onOpenShell }: { snapshot: NonNullable<ReturnType<typeof useMobileConversation>["snapshot"]>; brokenServers: ReturnType<typeof brokenMcpServers>; resuming: boolean; turnInFlight: boolean; onResume(): void; onReload(): void; onOpenShell(): void }) {
	const thread = snapshot.threadState;
	const signIn = signInCommand(snapshot.harness);
	return <>
		{snapshot.account?.reauthRequiredAt ? <InlineBanner tone="danger" icon="key" text={`${snapshot.account.reauthReason || "The provider rejected this session's credentials."} ${signIn ? `Run “${signIn}” on the AO host, then try again.` : "Sign in with the agent's CLI on the AO host, then try again."} AO holds no credentials of its own.`} action="Open shell" onPress={onOpenShell} /> : null}
		{snapshot.controller.state === "stopped" ? <InlineBanner tone="danger" icon="power" text={snapshot.controller.error || "The agent controller is stopped."} action={can(snapshot, "resume") ? (resuming ? "Resuming…" : "Resume") : "Open shell"} secondary={can(snapshot, "resume") ? "Shell" : undefined} onPress={can(snapshot, "resume") ? (resuming ? undefined : onResume) : onOpenShell} onSecondary={can(snapshot, "resume") ? onOpenShell : undefined} /> : null}
		{snapshot.controller.state === "recovering" || snapshot.controller.state === "connecting" ? <InlineBanner tone="warning" icon="loader" text={snapshot.controller.state === "recovering" ? "Reconnecting to the agent…" : "Starting the agent controller…"} /> : null}
		{thread?.status === "system_error" ? <InlineBanner tone="danger" icon="alert-triangle" text={`The provider reports an internal fault in this thread; AO's connection may still be healthy. The conversation and worktree are kept.${thread.waitingOn?.length ? ` Waiting on: ${thread.waitingOn.join(", ")}.` : ""}`} /> : thread?.status === "closed" ? <InlineBanner tone="warning" icon="alert-triangle" text={`The provider closed this thread. AO kept its history, but the agent no longer holds it.${thread.waitingOn?.length ? ` Waiting on: ${thread.waitingOn.join(", ")}.` : ""}`} /> : null}
		{brokenServers.length ? <InlineBanner tone="warning" icon="tool" text={`${brokenServers.map((server) => `${server.name}${server.failureReason || server.error ? ` (${server.failureReason || server.error})` : ""}`).join(", ")} ${brokenServers.length === 1 ? "is" : "are"} unavailable.`} action={can(snapshot, "mcp_reload") && !turnInFlight ? "Reload" : undefined} onPress={onReload} /> : null}
	</>;
}

function LiveTurnBar({ snapshot, stopping, onInterrupt }: { snapshot: NonNullable<ReturnType<typeof useMobileConversation>["snapshot"]>; stopping: boolean; onInterrupt(): void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const queued = snapshot.turns.filter((turn) => turn.state === "queued").length;
	const blocked = snapshot.items.some((item) => item.kind === "activity" && (item.activityKind === "approval" || item.activityKind === "user_input") && item.status === "pending");
	return <View style={styles.live}><ActivityIndicator size="small" color={blocked ? t.amber : t.orange} /><Text style={styles.liveText}>{blocked ? "Waiting for your input" : "Agent is working"}{queued ? ` · ${queued} queued` : ""}</Text><Pressable accessibilityRole="button" accessibilityLabel="Stop turn" disabled={stopping} onPress={onInterrupt} style={styles.stopTurn}><Feather name="square" size={11} color={t.textPrimary} /><Text style={styles.stopTurnText}>{stopping ? "Stopping…" : "Stop turn"}</Text></Pressable></View>;
}

function InlineBanner({ tone, icon, text, action, secondary, onPress, onSecondary }: { tone: "warning" | "danger" | "muted"; icon: keyof typeof Feather.glyphMap; text: string; action?: string; secondary?: string; onPress?(): void; onSecondary?(): void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const color = tone === "danger" ? t.red : tone === "warning" ? t.amber : t.textTertiary;
	const fill = tone === "danger" ? t.tintRed : tone === "warning" ? t.tintAmber : t.bgSubtle;
	return <View style={[styles.banner, { backgroundColor: fill }]}><Feather name={icon} size={13} color={color} /><Text style={styles.bannerText}>{text}</Text>{secondary ? <Pressable hitSlop={7} onPress={onSecondary}><Text style={styles.bannerSecondary}>{secondary}</Text></Pressable> : null}{action ? <Pressable hitSlop={7} onPress={onPress}><Text style={[styles.bannerAction, { color }]}>{action}</Text></Pressable> : null}</View>;
}

function ConversationMenu({ visible, onClose, snapshot, openingShell, onOpenShell, onPreview, onPullRequests, onSettings, onCompact, onReload, onRename }: { visible: boolean; onClose(): void; snapshot: NonNullable<ReturnType<typeof useMobileConversation>["snapshot"]>; openingShell: boolean; onOpenShell(): void; onPreview(): void; onPullRequests(): void; onSettings(): void; onCompact(): void; onReload(): void; onRename(title: string): void }) {
	const t = useTheme();
	const styles = useThemedStyles(makeStyles);
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(snapshot.title ?? "");
	const turnInFlight = snapshot.turns.some((turn) => turn.state === "running" || turn.state === "queued");
	useEffect(() => { if (visible) { setRenaming(false); setTitle(snapshot.title ?? ""); } }, [visible, snapshot.title]);
	return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><Pressable style={styles.menuScrim} onPress={onClose} /><View style={styles.menu}>
		{renaming ? <View style={styles.rename}><Text style={styles.menuHeading}>Rename conversation</Text><TextInput autoFocus value={title} onChangeText={setTitle} placeholder="Conversation title" placeholderTextColor={t.textFaint} style={styles.renameInput} /><View style={styles.menuButtons}><Pressable onPress={() => setRenaming(false)}><Text style={styles.menuCancel}>Cancel</Text></Pressable><Pressable disabled={!title.trim()} onPress={() => onRename(title.trim())}><Text style={styles.menuSave}>Save</Text></Pressable></View></View> : <ScrollView>
			<Text style={styles.menuHeading}>Conversation</Text>
			<MenuRow icon="terminal" label={openingShell ? "Opening shell…" : "Open worktree shell"} hint="A plain terminal in this session's worktree" disabled={openingShell} onPress={onOpenShell} />
			<MenuRow icon="globe" label="Open preview" hint="View a page or document generated in this worktree" onPress={onPreview} />
			<MenuRow icon="git-pull-request" label="Pull requests" hint="Review CI, feedback and merge state" onPress={onPullRequests} />
			<MenuRow icon="sliders" label="Turn settings" hint="Model, effort, approvals and provider options" onPress={onSettings} />
			{can(snapshot, "rename") ? <MenuRow icon="edit-2" label="Rename" onPress={() => setRenaming(true)} /> : null}
			{can(snapshot, "compaction") ? <MenuRow icon="archive" label="Compact history" hint={turnInFlight ? "Available after the current turn finishes" : snapshot.compactedAt ? `Last compacted ${new Date(snapshot.compactedAt).toLocaleString()}` : "Summarize older context without changing files"} disabled={turnInFlight} onPress={onCompact} /> : null}
			{can(snapshot, "mcp_reload") ? <MenuRow icon="refresh-cw" label="Reload MCP servers" hint={turnInFlight ? "Available after the current turn finishes" : undefined} disabled={turnInFlight} onPress={onReload} /> : null}
			{snapshot.usage ? <View style={styles.rateBox}><Text style={styles.rateTitle}>Context and usage</Text><Text style={styles.rateText}>{formatTokens(snapshot.usage.contextUsed)} / {formatTokens(snapshot.usage.contextWindow)} context · {formatTokens(snapshot.usage.inputTokens)} in · {formatTokens(snapshot.usage.outputTokens)} out{snapshot.usage.cachedTokens ? ` · ${formatTokens(snapshot.usage.cachedTokens)} cached` : ""}{snapshot.usage.cost != null ? ` · ${snapshot.usage.currency || "$"}${snapshot.usage.cost.toFixed(4)}` : ""}</Text></View> : null}
			{snapshot.rateLimits ? <View style={styles.rateBox}><Text style={styles.rateTitle}>{snapshot.rateLimits.planLabel || "Rate limits"}</Text><Text style={styles.rateText}>Primary: {Math.round(snapshot.rateLimits.primaryUsedPercent)}% used{formatReset(snapshot.rateLimits.primaryResetsInSeconds)}{snapshot.rateLimits.secondaryUsedPercent >= 0 ? ` · Secondary: ${Math.round(snapshot.rateLimits.secondaryUsedPercent)}%${formatReset(snapshot.rateLimits.secondaryResetsInSeconds)}` : ""}</Text></View> : null}
		</ScrollView>}
	</View></Modal>;
}

function MenuRow({ icon, label, hint, disabled, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; hint?: string; disabled?: boolean; onPress(): void }) { const t = useTheme(); const styles = useThemedStyles(makeStyles); return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={() => { haptics.tap(); onPress(); }} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: t.bgSubtle }, disabled && { opacity: 0.45 }]}><Feather name={icon} size={16} color={t.textTertiary} /><View style={{ flex: 1 }}><Text style={styles.menuLabel}>{label}</Text>{hint ? <Text style={styles.menuHint}>{hint}</Text> : null}</View><Feather name="chevron-right" size={15} color={t.textFaint} /></Pressable>; }

function Unavailable({ message, onShell, openingShell }: { message: string; onShell(): void; openingShell: boolean }) { return <Centered icon="alert-triangle" title="Conversation unavailable" message={`${message}\n\nThe worktree is untouched. You can still open a plain shell in it.`} action={openingShell ? "Opening…" : "Open worktree shell"} onAction={onShell} />; }
function Centered({ icon, title, message, spinning, action, onAction }: { icon: keyof typeof Feather.glyphMap; title: string; message?: string; spinning?: boolean; action?: string; onAction?(): void }) { const t = useTheme(); const styles = useThemedStyles(makeStyles); return <View style={styles.center}>{spinning ? <ActivityIndicator color={t.blue} /> : <Feather name={icon} size={22} color={t.amber} />}<Text style={styles.centerTitle}>{title}</Text>{message ? <Text style={styles.centerCopy}>{message}</Text> : null}{action ? <Pressable onPress={onAction} style={styles.centerAction}><Text style={styles.centerActionText}>{action}</Text></Pressable> : null}</View>; }

function sessionTitle(session: MobileChatSession): string { return "displayName" in session ? session.displayName || session.issueTitle || session.issueLabel || session.id : session.projectName || session.id; }
function formatTokens(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value); }
function signInCommand(harness: string): string | undefined { return harness === "codex" ? "codex login" : harness === "claude-code" || harness === "claude" ? "claude auth login" : undefined; }
function formatReset(seconds?: number): string { if (seconds === undefined || seconds < 0) return ""; if (seconds < 60) return ` · resets in ${Math.ceil(seconds)}s`; if (seconds < 3600) return ` · resets in ${Math.ceil(seconds / 60)}m`; return ` · resets in ${Math.ceil(seconds / 3600)}h`; }

const makeStyles = (t: Theme) => StyleSheet.create({
	screen: { flex: 1, backgroundColor: t.bgBase },
	headerAction: { width: 36, height: 32, alignItems: "center", justifyContent: "center" },
	meta: { minHeight: 37, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, backgroundColor: t.bgSurface, borderBottomWidth: 1, borderBottomColor: t.borderSubtle },
	dot: { width: 7, height: 7, borderRadius: 4 },
	harness: { color: t.textSecondary, fontSize: 11, fontWeight: "600" },
	mode: { color: t.textFaint, borderWidth: 1, borderColor: t.borderSubtle, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, fontSize: 8, letterSpacing: 1 },
	usage: { width: 54, height: 5, borderRadius: 3, backgroundColor: t.bgSubtle, overflow: "hidden" },
	usageFill: { height: 5, borderRadius: 3, backgroundColor: t.blue },
	percent: { color: t.textTertiary, fontSize: 10, fontFamily: t.fontMono },
	banner: { minHeight: 35, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: t.borderSubtle },
	bannerText: { flex: 1, color: t.textSecondary, fontSize: 11, lineHeight: 15 },
	bannerAction: { fontSize: 11, fontWeight: "700" },
	bannerSecondary: { color: t.textTertiary, fontSize: 11, fontWeight: "600" },
	live: { minHeight: 35, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13, backgroundColor: t.bgSurface, borderTopWidth: 1, borderTopColor: t.borderSubtle },
	liveText: { color: t.textSecondary, fontSize: 11 },
	stopTurn: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 7, borderWidth: 1, borderColor: t.borderDefault, paddingHorizontal: 8, paddingVertical: 5 },
	stopTurnText: { color: t.textPrimary, fontSize: 10, fontWeight: "600" },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 38, backgroundColor: t.bgBase },
	centerTitle: { color: t.textPrimary, fontSize: 17, fontWeight: "700", textAlign: "center" },
	centerCopy: { color: t.textSecondary, fontSize: 13, lineHeight: 19, textAlign: "center" },
	centerAction: { minHeight: 42, justifyContent: "center", backgroundColor: t.blue, borderRadius: 11, paddingHorizontal: 15, marginTop: 4 },
	centerActionText: { color: t.onAccent, fontSize: 13, fontWeight: "700" },
	menuScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: t.scrim },
	menu: { position: "absolute", top: 76, right: 12, width: "88%", maxWidth: 310, maxHeight: "75%", backgroundColor: t.bgSurface, borderRadius: 16, borderWidth: 1, borderColor: t.borderDefault, overflow: "hidden" },
	menuHeading: { color: t.textPrimary, fontSize: 14, fontWeight: "700", paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8 },
	menuRow: { minHeight: 57, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 14, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.borderSubtle },
	menuLabel: { color: t.textPrimary, fontSize: 13, fontWeight: "600" },
	menuHint: { color: t.textTertiary, fontSize: 10, lineHeight: 14, marginTop: 2 },
	rateBox: { padding: 14, borderTopWidth: 1, borderTopColor: t.borderSubtle, gap: 3 },
	rateTitle: { color: t.textSecondary, fontSize: 11, fontWeight: "700" },
	rateText: { color: t.textTertiary, fontSize: 10, lineHeight: 14 },
	rename: { padding: 14, gap: 10 },
	renameInput: { minHeight: 42, borderRadius: 10, backgroundColor: t.bgElevated, borderWidth: 1, borderColor: t.borderDefault, color: t.textPrimary, paddingHorizontal: 11 },
	menuButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 18, paddingTop: 3 },
	menuCancel: { color: t.textTertiary, fontSize: 12, fontWeight: "600" },
	menuSave: { color: t.blue, fontSize: 12, fontWeight: "700" },
});
