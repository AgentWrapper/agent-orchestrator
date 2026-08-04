import { useRouter } from "expo-router";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { setOnboardingSkipped } from "../lib/onboardingStore";
import { useApp } from "../lib/store";
import { Button, NumberedStep } from "../lib/ui";
import MASCOT from "../assets/mascot.png";
import { useThemedStyles } from "../lib/ThemeProvider";
import type { Theme } from "../lib/theme";
import { useT } from "../lib/i18n";

export default function OnboardingScreen() {
	const tr = useT();
	const styles = useThemedStyles(makeStyles);
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const { reloadConfig } = useApp();

	async function skip() {
		await setOnboardingSkipped();
		await reloadConfig();
		router.replace("/");
	}

	return (
		<View style={[styles.screen, { paddingTop: insets.top }]}>
			<View style={styles.topBar}>
				<View style={styles.brand}>
					<Image source={MASCOT} style={styles.mascot} resizeMode="contain" />
					<Text style={styles.brandName}>AO</Text>
				</View>
				<Pressable onPress={skip} hitSlop={12} accessibilityRole="button">
					<Text style={styles.skip}>{tr("onboarding.skip")}</Text>
				</Pressable>
			</View>

			<ScrollView
				style={styles.scroll}
				contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
				showsVerticalScrollIndicator={false}
			>
				<View style={styles.hero}>
					<Text style={styles.title}>{tr("onboarding.title")}</Text>
					<Text style={styles.lede}>{tr("onboarding.lede")}</Text>
					<Button
						title={tr("onboarding.pairDesktop")}
						icon="maximize"
						onPress={() => router.push("/pair?from=onboarding")}
						style={styles.cta}
					/>
				</View>

				<View style={styles.how}>
					<Text style={styles.howLabel}>{tr("onboarding.how")}</Text>
					<NumberedStep
						n={1}
						title={tr("onboarding.step1Title")}
						hint={tr("onboarding.step1Hint")}
					/>
					<View style={styles.divider} />
					<NumberedStep
						n={2}
						title={tr("onboarding.step2Title")}
						hint={tr("onboarding.step2Hint")}
					/>
					<View style={styles.divider} />
					<NumberedStep
						n={3}
						title={tr("onboarding.step3Title")}
						hint={tr("onboarding.step3Hint")}
					/>
				</View>
			</ScrollView>
		</View>
	);
}

const makeStyles = (t: Theme) =>
	StyleSheet.create({
	screen: { flex: 1, backgroundColor: t.bgBase },
	topBar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 20,
		paddingTop: 6,
		paddingBottom: 4,
	},
	brand: { flexDirection: "row", alignItems: "center", gap: 8 },
	mascot: { width: 26, height: 23 },
	brandName: { color: t.textPrimary, fontSize: 17, fontWeight: "800", letterSpacing: -0.2 },
	skip: { color: t.textTertiary, fontSize: 15, fontWeight: "600" },

	scroll: { flex: 1 },
	body: { flexGrow: 1, paddingHorizontal: 24 },
	hero: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingVertical: 32 },
	title: {
		color: t.textPrimary,
		fontSize: 32,
		fontWeight: "800",
		letterSpacing: -0.8,
		textAlign: "center",
	},
	lede: {
		color: t.textSecondary,
		fontSize: 15,
		lineHeight: 23,
		textAlign: "center",
		marginTop: 14,
		maxWidth: 330,
	},
	cta: { marginTop: 32, alignSelf: "center", width: "100%", maxWidth: 300 },
	how: {},
	howLabel: {
		color: t.textTertiary,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 1.3,
		marginBottom: 4,
	},
	divider: { height: 1, backgroundColor: t.borderSubtle, marginLeft: 43 },
});
