import { useScrollToTop } from "@react-navigation/native";
import { type RefObject, useRef } from "react";

// The ref shape @react-navigation/native accepts (ScrollView, FlatList,
// SectionList, ...). The package doesn't export it, so derive it from the hook.
type ScrollableRef = Parameters<typeof useScrollToTop>[0];

/**
 * Ref for a tab screen's scroll container, wired so that tapping the
 * already-active tab scrolls it back to the top - the standard iOS tab-bar
 * gesture. Pressing a *different* tab just switches, as usual.
 *
 * Attach the returned ref to the screen's scroll container:
 *
 *     const scrollRef = useTabScrollToTop<ScrollView>();
 *     <ScrollView ref={scrollRef} ... />
 *
 * This is also the single place we import `@react-navigation/native`, which
 * reaches us transitively through expo-router rather than as a declared
 * dependency - keeping that coupling in one file.
 */
export function useTabScrollToTop<T>(): RefObject<T | null> {
	const ref = useRef<T>(null);
	// Callers always pass a scrollable; the generic keeps the JSX ref precise.
	useScrollToTop(ref as ScrollableRef);
	return ref;
}
