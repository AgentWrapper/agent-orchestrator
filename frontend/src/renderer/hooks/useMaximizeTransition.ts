import { useCallback, useEffect, useRef } from "react";
import { useFlipTransition } from "./useFlipTransition";

export type MaximizeTransitionController = {
	/** Attach to whichever element currently renders the maximizable surface. */
	setNodeRef: (node: HTMLElement | null) => void;
	/** Call synchronously right before flipping the `maximized` state, to record where the FLIP animation should grow/shrink from. */
	captureOrigin: () => void;
};

// Drives a FLIP grow/shrink transition whenever `maximized` changes, using the
// rect captured by the last captureOrigin() call as the animation's start
// point. Shared by the Browser panel (paired with begin/end native-view-hide
// hooks via onSettle) and the File diff viewer (pure DOM, no native view to
// coordinate) — see DESIGN.md's Motion section for the approved scope.
export function useMaximizeTransition(maximized: boolean, onSettle?: () => void): MaximizeTransitionController {
	const flip = useFlipTransition();
	const nodeRef = useRef<HTMLElement | null>(null);

	const setNodeRef = useCallback((node: HTMLElement | null) => {
		nodeRef.current = node;
	}, []);

	const captureOrigin = useCallback(() => {
		if (nodeRef.current) flip.captureRect(nodeRef.current);
	}, [flip]);

	useEffect(() => {
		// playFlip itself handles a null node (settles onSettle immediately, no
		// animation) — always call it, rather than skipping onSettle entirely
		// when the target is unmounted (e.g. a session switch mid-transition),
		// which would otherwise leave a caller's begin/end pairing stuck open.
		flip.playFlip(nodeRef.current, { onSettle });
		// Runs once per `maximized` flip, using whatever origin captureOrigin()
		// last recorded (or none, which settles immediately with no animation).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maximized]);

	return { setNodeRef, captureOrigin };
}
