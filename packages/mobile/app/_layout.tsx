import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../lib/store";
import { theme } from "../lib/theme";

export default function RootLayout() {
	return (
		<SafeAreaProvider>
			<AppProvider>
				<StatusBar style="light" />
				<Stack
					screenOptions={{
						headerStyle: { backgroundColor: theme.bgSurface },
						headerTintColor: theme.textPrimary,
						headerTitleStyle: { fontWeight: "700" },
						headerShadowVisible: false,
						contentStyle: { backgroundColor: theme.bgBase },
					}}
				>
					<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
					<Stack.Screen name="session/[id]" options={{ title: "Terminal", headerBackTitle: "Back" }} />
					<Stack.Screen name="spawn" options={{ presentation: "modal", title: "New agent" }} />
				</Stack>
			</AppProvider>
		</SafeAreaProvider>
	);
}
