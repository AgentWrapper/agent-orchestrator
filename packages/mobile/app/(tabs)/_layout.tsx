import { Feather } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "../../lib/haptics";
import { theme } from "../../lib/theme";

export default function TabsLayout() {
	const insets = useSafeAreaInsets();
	return (
		<Tabs
			screenListeners={{ tabPress: () => haptics.select() }}
			screenOptions={{
				headerShown: false,
				tabBarActiveTintColor: theme.blue,
				tabBarInactiveTintColor: theme.textTertiary,
				tabBarStyle: {
					backgroundColor: theme.bgSurface,
					borderTopColor: theme.borderSubtle,
					borderTopWidth: 1,
					// Drive height/padding from the real safe-area inset so the bar clears
					// the Android gesture-nav bar (edge-to-edge is on by default in SDK 54)
					// and the iOS home indicator - instead of guessing fixed per-platform
					// numbers that leave the bar under the system nav on Android.
					height: 56 + insets.bottom,
					paddingTop: 6,
					paddingBottom: insets.bottom + 6,
				},
				tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: "Kanban",
					tabBarIcon: ({ color, size }) => <Feather name="grid" size={size - 2} color={color} />,
				}}
			/>
			<Tabs.Screen
				name="prs"
				options={{
					title: "PRs",
					tabBarIcon: ({ color, size }) => <Feather name="git-pull-request" size={size - 2} color={color} />,
				}}
			/>
			<Tabs.Screen
				name="orchestrator"
				options={{
					title: "Orchestrator",
					tabBarIcon: ({ color, size }) => <Feather name="share-2" size={size - 2} color={color} />,
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					title: "Settings",
					tabBarIcon: ({ color, size }) => <Feather name="settings" size={size - 2} color={color} />,
				}}
			/>
		</Tabs>
	);
}
