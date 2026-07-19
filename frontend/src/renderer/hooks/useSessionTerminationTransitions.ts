import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { attentionZone, sessionIsActive, type WorkspaceSession } from "../types/workspace";
import type { AttentionZone } from "../lib/session-presentation";

export const SESSION_TERMINATION_TRANSITION_MS = 1200;

export type SessionTerminationTransition = {
	session: WorkspaceSession;
	previousTitle: string;
	previousZone: AttentionZone;
	startedAt: number;
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useSessionTerminationTransitions(
	sessions: WorkspaceSession[],
): Record<string, SessionTerminationTransition> {
	const previousRef = useRef<Map<string, WorkspaceSession>>(new Map());
	const [transitions, setTransitions] = useState<Record<string, SessionTerminationTransition>>({});

	useIsomorphicLayoutEffect(() => {
		const currentById = new Map(sessions.map((session) => [session.id, session]));
		const previousById = previousRef.current;
		setTransitions((current) => {
			let next = current;
			const mutableNext = () => {
				if (next === current) next = { ...current };
				return next;
			};

			for (const [id, transition] of Object.entries(current)) {
				const session = currentById.get(id);
				if (!session || sessionIsActive(session)) {
					delete mutableNext()[id];
					continue;
				}
				if (session !== transition.session) {
					mutableNext()[id] = { ...transition, session };
				}
			}

			for (const session of sessions) {
				if (sessionIsActive(session) || next[session.id]) continue;
				const previous = previousById.get(session.id);
				if (!previous || !sessionIsActive(previous)) continue;
				mutableNext()[session.id] = {
					session,
					previousTitle: previous.title,
					previousZone: attentionZone(previous),
					startedAt: Date.now(),
				};
			}

			return next;
		});
		previousRef.current = currentById;
	}, [sessions]);

	useEffect(() => {
		const entries = Object.entries(transitions);
		if (entries.length === 0 || typeof window === "undefined") return;
		const timers = entries.map(([id, transition]) => {
			const elapsed = Date.now() - transition.startedAt;
			return window.setTimeout(
				() =>
					setTransitions((current) => {
						if (current[id]?.startedAt !== transition.startedAt) return current;
						const next = { ...current };
						delete next[id];
						return next;
					}),
				Math.max(0, SESSION_TERMINATION_TRANSITION_MS - elapsed),
			);
		});
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [transitions]);

	return transitions;
}
