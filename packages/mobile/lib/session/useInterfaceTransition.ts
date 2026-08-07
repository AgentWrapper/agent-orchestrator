import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerConfig } from "../config";
import {
	cancelSessionInterfaceTransition,
	getSessionInterfaceTransition,
	startSessionInterfaceTransition,
	type SessionInterfaceTransition,
	type SessionInterfaceTransitionStatus,
} from "../chat/api";

const activePhases = new Set<SessionInterfaceTransition["phase"]>([
	"requested",
	"preflighting",
	"draining",
	"source_stopping",
	"source_stopped",
	"target_starting",
	"activating",
]);

export function mobileInterfaceTransitionIsActive(transition?: SessionInterfaceTransition): boolean {
	return Boolean(transition && activePhases.has(transition.phase));
}

export function mobileInterfaceTransitionIsCancellable(transition?: SessionInterfaceTransition): boolean {
	return Boolean(
		transition && ["requested", "preflighting", "draining"].includes(transition.phase),
	);
}

export function useInterfaceTransition(
	cfg: ServerConfig | null,
	sessionId: string,
	onSettled?: () => void | Promise<void>,
) {
	const [status, setStatus] = useState<SessionInterfaceTransitionStatus>();
	const [loading, setLoading] = useState(Boolean(cfg && sessionId));
	const [starting, setStarting] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	const [error, setError] = useState<string>();
	const settledRef = useRef("");
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;

	const refresh = useCallback(async () => {
		if (!cfg || !sessionId) return;
		try {
			const next = await getSessionInterfaceTransition(cfg, sessionId);
			setStatus(next);
			setError(undefined);
			const transition = next.transition;
			if (transition && !mobileInterfaceTransitionIsActive(transition) && settledRef.current !== transition.id) {
				settledRef.current = transition.id;
				await onSettledRef.current?.();
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [cfg, sessionId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!cfg || !sessionId) return;
		const interval = mobileInterfaceTransitionIsActive(status?.transition) ? 300 : 10_000;
		const timer = setInterval(() => void refresh(), interval);
		return () => clearInterval(timer);
	}, [cfg, refresh, sessionId, status?.transition?.phase]);

	const start = useCallback(
		async (targetMode: "chat" | "tui", policy: "drain" | "interrupt") => {
			if (!cfg) throw new Error("No AO server configured");
			setStarting(true);
			setError(undefined);
			try {
				const transition = await startSessionInterfaceTransition(cfg, sessionId, targetMode, policy);
				setStatus((current) => ({
					supported: current?.supported ?? true,
					targetMode,
					transition,
				}));
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				setError(message);
				throw cause;
			} finally {
				setStarting(false);
			}
		},
		[cfg, sessionId],
	);

	const cancel = useCallback(async () => {
		if (!cfg) throw new Error("No AO server configured");
		setCancelling(true);
		setError(undefined);
		try {
			await cancelSessionInterfaceTransition(cfg, sessionId);
			await refresh();
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			throw cause;
		} finally {
			setCancelling(false);
		}
	}, [cfg, refresh, sessionId]);

	return { status, transition: status?.transition, loading, starting, cancelling, error, start, cancel, refresh };
}
