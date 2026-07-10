import { ScrollView, StyleSheet, View } from "react-native";
import { useApp } from "./store";
import { Pill } from "./ui";

// Horizontal pill row to scope the view to one project (or All). Only renders
// when there's more than one project - single-project users never see clutter.
//
// The row lives in a fixed-height wrapper that the ScrollView fills via flex.
// On the New Architecture (Expo SDK 54) a bare `height` on a horizontal
// ScrollView isn't laid out deterministically - its measured height drifts
// between re-renders (e.g. switching the active chip), nudging everything below
// it. A bounded parent + flex pins the row to one height in every state.
export function ProjectSwitcher() {
	const { projects, activeProjectId, setActiveProject } = useApp();
	if (projects.length <= 1) return null;

	const items = [{ id: "all", name: "All" }, ...projects];

	return (
		<View style={styles.container}>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				style={styles.scroll}
				contentContainerStyle={styles.row}
			>
				{items.map((p) => (
					<Pill
						key={p.id}
						label={p.name}
						active={activeProjectId === p.id}
						onPress={() => setActiveProject(p.id)}
						style={styles.pill}
					/>
				))}
			</ScrollView>
		</View>
	);
}

const ROW_HEIGHT = 40;

const styles = StyleSheet.create({
	container: { height: ROW_HEIGHT, marginBottom: 12 },
	scroll: { flex: 1 },
	row: { paddingHorizontal: 16, gap: 8, alignItems: "center" },
	pill: { flexShrink: 0 },
});
