import { ScrollView, StyleSheet } from "react-native";
import { useApp } from "./store";
import { Pill } from "./ui";

// Horizontal pill row to scope the view to one project (or All). Only renders
// when there's more than one project — single-project users never see clutter.
export function ProjectSwitcher() {
	const { projects, activeProjectId, setActiveProject } = useApp();
	if (projects.length <= 1) return null;

	const items = [{ id: "all", name: "All" }, ...projects];

	return (
		<ScrollView
			horizontal
			showsHorizontalScrollIndicator={false}
			style={styles.scroll}
			contentContainerStyle={styles.row}
		>
			{items.map((p) => (
				<Pill key={p.id} label={p.name} active={activeProjectId === p.id} onPress={() => setActiveProject(p.id)} />
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	scroll: { flexGrow: 0 },
	row: { paddingHorizontal: 16, paddingBottom: 12, gap: 8, alignItems: "center" },
});
