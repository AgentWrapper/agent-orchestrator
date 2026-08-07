import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ServerConfig } from "../config";
import {
	compactConversation,
	getConversationConfigOptions,
	getConversationModels,
	getConversationPage,
	getConversationSkills,
	mergeConversationPages,
	reloadMcpServers,
	resolveApproval,
	resolveInput,
	rollbackConversation,
	sendConversationMessage,
	setConversationConfigOption,
	setConversationSettings,
	setConversationTitle,
	stageConversationAttachments,
	steerConversation,
	streamConversationEvents,
	interruptConversation,
	type ConversationPage,
} from "./api";
import type { ChatConfigOption, ChatImage, ChatModel, ChatResource, ChatSkill, ConversationSnapshot, TurnSettings } from "./types";
import { discardHistoricalPages } from "./snapshot";
import { conversationActionError, conversationErrorCode } from "./conversationErrors";

const REFRESH_DEBOUNCE_MS = 120;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export type PendingSend = {
	id: string;
	text: string;
	state: "sending" | "failed";
	error?: string;
	attachments?: ChatImage[];
	resources?: ChatResource[];
};

export type ConversationAction =
	| "steer"
	| "interrupt"
	| "approval"
	| "input"
	| "compact"
	| "rollback"
	| "settings"
	| "config"
	| "mcp"
	| "rename";

export type MobileConversation = {
	snapshot?: ConversationSnapshot;
	loading: boolean;
	refreshing: boolean;
	loadingOlder: boolean;
	error?: string;
	unavailable?: { code?: string; message: string };
	models: ChatModel[];
	configOptions: ChatConfigOption[];
	skills: ChatSkill[];
	pendingSends: PendingSend[];
	pendingActions: readonly ConversationAction[];
	actionError?: string;
	actionErrors: Partial<Record<ConversationAction, string>>;
	actionCodes: Partial<Record<ConversationAction, string>>;
	refresh(): Promise<void>;
	loadOlder(): Promise<void>;
	send(text: string, attachments?: ChatImage[], resources?: ChatResource[]): Promise<void>;
	retrySend(id: string): Promise<void>;
	discardSend(id: string): void;
	steer(text: string): Promise<void>;
	interrupt(): Promise<void>;
	resolveApproval(requestId: string, decisionId: string): Promise<void>;
	resolveInput(requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>): Promise<void>;
	compact(): Promise<void>;
	rollback(turnId: string): Promise<number>;
	chooseSettings(settings: TurnSettings): Promise<void>;
	setConfigOption(optionId: string, value: { value: string } | { enabled: boolean }): Promise<void>;
	reloadMcp(): Promise<void>;
	rename(title: string): Promise<void>;
};

export function useMobileConversation(
	cfg: ServerConfig | null,
	sessionId: string,
): MobileConversation {
	const [pages, setPages] = useState<ConversationPage[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [error, setError] = useState<string>();
	const [unavailable, setUnavailable] = useState<{ code?: string; message: string }>();
	const [models, setModels] = useState<ChatModel[]>([]);
	const [configOptions, setConfigOptions] = useState<ChatConfigOption[]>([]);
	const [skills, setSkills] = useState<ChatSkill[]>([]);
	const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
	const [pendingActions, setPendingActions] = useState<ConversationAction[]>([]);
	const [actionError, setActionError] = useState<string>();
	const [actionErrors, setActionErrors] = useState<Partial<Record<ConversationAction, string>>>({});
	const [actionCodes, setActionCodes] = useState<Partial<Record<ConversationAction, string>>>({});
	const mounted = useRef(true);
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const snapshot = useMemo(() => mergeConversationPages(pages), [pages]);
	const hasConversation = Boolean(snapshot);
	const hasProviderConfig = Boolean(snapshot?.capabilities?.includes("config_options"));

	const refresh = useCallback(async () => {
		if (!cfg) return;
		setRefreshing(true);
		try {
			const live = await getConversationPage(cfg, sessionId);
			if (!mounted.current) return;
			setPages((old) => {
				if (old[0]?.conversationId && old[0].conversationId !== live.conversationId) return [live];
				return [live, ...old.slice(1)];
			});
			setUnavailable(undefined);
			setError(undefined);
		} catch (cause) {
			if (!mounted.current) return;
			const classified = classifyConversationError(cause);
			if (classified.permanent) setUnavailable({ code: classified.code, message: classified.message });
			else setError(classified.message);
		} finally {
			if (mounted.current) {
				setLoading(false);
				setRefreshing(false);
			}
		}
	}, [cfg, sessionId]);

	const scheduleRefresh = useCallback(() => {
		if (refreshTimer.current) clearTimeout(refreshTimer.current);
		refreshTimer.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
	}, [refresh]);

	const loadOlder = useCallback(async () => {
		if (!cfg || !snapshot?.hasMoreBefore || loadingOlder) return;
		setLoadingOlder(true);
		try {
			const older = await getConversationPage(cfg, sessionId, snapshot.oldestSequence);
			if (mounted.current) setPages((old) => [...old, older]);
		} catch (cause) {
			if (mounted.current) setActionError(conversationActionError(cause));
		} finally {
			if (mounted.current) setLoadingOlder(false);
		}
	}, [cfg, sessionId, snapshot?.hasMoreBefore, snapshot?.oldestSequence, loadingOlder]);

	useEffect(() => {
		mounted.current = true;
		setPages([]);
		setLoading(true);
		setUnavailable(undefined);
		void refresh();
		return () => {
			mounted.current = false;
			if (refreshTimer.current) clearTimeout(refreshTimer.current);
		};
	}, [refresh]);

	// Provider catalogs are live session state. They fail independently so a
	// missing optional facility never hides an otherwise healthy conversation.
	useEffect(() => {
		if (!cfg || unavailable || !hasConversation) return;
		let cancelled = false;
		const load = async () => {
			const [modelResult, configResult, skillResult] = await Promise.allSettled([
				hasProviderConfig ? Promise.resolve([]) : getConversationModels(cfg, sessionId),
				hasProviderConfig ? getConversationConfigOptions(cfg, sessionId) : Promise.resolve([]),
				getConversationSkills(cfg, sessionId),
			]);
			if (cancelled) return;
			if (modelResult.status === "fulfilled") setModels(modelResult.value);
			if (configResult.status === "fulfilled") setConfigOptions(configResult.value);
			if (skillResult.status === "fulfilled") setSkills(skillResult.value);
		};
		void load();
		const configPoll = hasProviderConfig ? setInterval(() => {
			void getConversationConfigOptions(cfg, sessionId).then((value) => !cancelled && setConfigOptions(value)).catch(() => {});
		}, 5_000) : undefined;
		const skillPoll = setInterval(() => {
			void getConversationSkills(cfg, sessionId).then((value) => !cancelled && setSkills(value)).catch(() => {});
		}, 60_000);
		return () => {
			cancelled = true;
			if (configPoll) clearInterval(configPoll);
			clearInterval(skillPoll);
		};
	}, [cfg, sessionId, unavailable, hasConversation, hasProviderConfig]);

	// The daemon owns durable replay. Persist only the cursor; after backgrounding
	// the phone reconnects from that point and then reloads the authoritative page.
	useEffect(() => {
		if (!cfg || unavailable) return;
		let stopped = false;
		let controller: AbortController | undefined;
		const cursorKey = eventCursorKey(cfg, sessionId);
		const run = async () => {
			let cursor = Number(await AsyncStorage.getItem(cursorKey)) || 0;
			let delay = RECONNECT_MIN_MS;
			while (!stopped) {
				controller = new AbortController();
				try {
					cursor = await streamConversationEvents(cfg, sessionId, cursor, controller.signal, (event) => {
						cursor = Math.max(cursor, event.seq);
						void AsyncStorage.setItem(cursorKey, String(cursor));
						if (event.payload?.conversationId) scheduleRefresh();
					});
					delay = RECONNECT_MIN_MS;
				} catch {
					if (stopped || controller.signal.aborted) return;
				}
				await wait(delay);
				delay = Math.min(RECONNECT_MAX_MS, delay * 2);
			}
		};
		void run();
		return () => {
			stopped = true;
			controller?.abort();
		};
	}, [cfg, sessionId, scheduleRefresh, unavailable]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active") void refresh();
		});
		return () => subscription.remove();
	}, [refresh]);

	const runAction = useCallback(
		async <T,>(kind: ConversationAction, action: () => Promise<T>, resetHistoricalPages = false): Promise<T> => {
			setPendingActions((old) => old.includes(kind) ? old : [...old, kind]);
			setActionError(undefined);
			setActionErrors((old) => ({ ...old, [kind]: undefined }));
			setActionCodes((old) => ({ ...old, [kind]: undefined }));
			try {
				const result = await action();
				if (resetHistoricalPages) setPages(discardHistoricalPages);
				await refresh();
				return result;
			} catch (cause) {
				const message = conversationActionError(cause);
				setActionError(message);
				setActionErrors((old) => ({ ...old, [kind]: message }));
				setActionCodes((old) => ({ ...old, [kind]: conversationErrorCode(cause) }));
				throw new Error(message);
			} finally {
				setPendingActions((old) => old.filter((candidate) => candidate !== kind));
			}
		},
		[refresh],
	);

	const deliver = useCallback(
		async (pending: PendingSend) => {
			if (!cfg) throw new Error("No AO server configured");
			setPendingSends((old) => upsertPending(old, { ...pending, state: "sending", error: undefined }));
			try {
				await sendConversationMessage(cfg, sessionId, {
					text: pending.text,
					clientMessageId: pending.id,
					attachments: pending.attachments,
					resources: pending.resources,
				});
				setPendingSends((old) => old.filter((item) => item.id !== pending.id));
				await refresh();
			} catch (cause) {
				const message = conversationActionError(cause);
				setPendingSends((old) => upsertPending(old, { ...pending, state: "failed", error: message }));
				throw new Error(message);
			}
		},
		[cfg, sessionId, refresh],
	);

	const send = useCallback(
		async (text: string, attachments?: ChatImage[], resources?: ChatResource[]) => {
			const id = clientMessageId();
			let message = text;
			let nativeAttachments = attachments;
			if (attachments?.length) {
				const paths = await requireConfig(cfg, (c) => stageConversationAttachments(c, sessionId, attachments));
				message = withAttachmentReferences(message, paths);
				if (!snapshot?.capabilities?.includes("images")) nativeAttachments = undefined;
			}
			await deliver({ id, text: message, state: "sending", attachments: nativeAttachments, resources });
		},
		[cfg, sessionId, snapshot?.capabilities, deliver],
	);

	const retrySend = useCallback(
		async (id: string) => {
			const pending = pendingSends.find((item) => item.id === id);
			if (pending) await deliver(pending);
		},
		[pendingSends, deliver],
	);

	return {
		snapshot,
		loading,
		refreshing,
		loadingOlder,
		error,
		unavailable,
		models,
		configOptions,
		skills,
		pendingSends,
		pendingActions,
		actionError,
		actionErrors,
		actionCodes,
		refresh,
		loadOlder,
		send,
		retrySend,
		discardSend: (id) => setPendingSends((old) => old.filter((item) => item.id !== id)),
		steer: (text) => runAction("steer", () => requireConfig(cfg, (c) => steerConversation(c, sessionId, text, clientMessageId()))),
		interrupt: () => runAction("interrupt", () => requireConfig(cfg, (c) => interruptConversation(c, sessionId))),
		resolveApproval: (requestId, decisionId) =>
			runAction("approval", () => requireConfig(cfg, (c) => resolveApproval(c, sessionId, requestId, decisionId))),
		resolveInput: (requestId, action, content) =>
			runAction("input", () => requireConfig(cfg, (c) => resolveInput(c, sessionId, requestId, action, content))),
		compact: () => runAction("compact", () => requireConfig(cfg, (c) => compactConversation(c, sessionId))),
		rollback: (turnId) => runAction("rollback", () => requireConfig(cfg, (c) => rollbackConversation(c, sessionId, turnId)), true),
		chooseSettings: (settings) => runAction("settings", () => requireConfig(cfg, (c) => setConversationSettings(c, sessionId, settings))),
		setConfigOption: (optionId, value) =>
			runAction("config", async () => {
				const options = await requireConfig(cfg, (c) => setConversationConfigOption(c, sessionId, optionId, value));
				setConfigOptions(options);
			}),
		reloadMcp: () => runAction("mcp", () => requireConfig(cfg, (c) => reloadMcpServers(c, sessionId))),
		rename: (title) => runAction("rename", () => requireConfig(cfg, (c) => setConversationTitle(c, sessionId, title))),
	};
}

async function requireConfig<T>(cfg: ServerConfig | null, action: (cfg: ServerConfig) => Promise<T>): Promise<T> {
	if (!cfg) throw new Error("No AO server configured");
	return action(cfg);
}

function clientMessageId(): string {
	return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function upsertPending(items: PendingSend[], next: PendingSend): PendingSend[] {
	const index = items.findIndex((item) => item.id === next.id);
	if (index < 0) return [...items, next];
	return items.map((item, at) => (at === index ? next : item));
}

function classifyConversationError(error: unknown): { permanent: boolean; code?: string; message: string } {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : undefined;
	const permanentCodes = new Set([
		"SESSION_MODE_MISMATCH",
		"SESSION_NOT_FOUND",
		"SESSION_MODE_UNSUPPORTED",
		"CHAT_DRIVER_UNAVAILABLE",
		"CHAT_DRIVER_INCOMPATIBLE",
		"CHAT_AUTH_REQUIRED",
		"CHAT_RESUME_FAILED",
		"CHAT_CONTROLLER_NOT_READY",
	]);
	return {
		permanent: Boolean(code && permanentCodes.has(code)),
		code,
		message: conversationActionError(error),
	};
}

function eventCursorKey(cfg: ServerConfig, sessionId: string): string {
	return `ao.chat.events.${cfg.host}.${cfg.httpPort}.${sessionId}`;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function withAttachmentReferences(text: string, paths: string[]): string {
	if (paths.length === 0) return text;
	const references = paths.map((path) => `- ${path}`).join("\n");
	return `${text.trim()}${text.trim() ? "\n\n" : ""}Attached files are available in the worktree:\n${references}`;
}
