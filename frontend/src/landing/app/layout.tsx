import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { HomeScrollReset } from "@/components/HomeScrollReset";
import { ThemeProvider } from "@/components/theme-provider";
import "../styles/globals.css";

const inter = Inter({
	subsets: ["latin"],
	display: "swap",
	variable: "--font-inter",
});

export const metadata: Metadata = {
	title: "Agent Orchestrator",
	description: "Open-source platform for running parallel AI coding agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning className={`${inter.variable} ${GeistSans.variable} ${GeistMono.variable}`}>
			<body className={`${inter.variable} ${inter.className} font-sans`}>
				<ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
					<HomeScrollReset />
					{children}
				</ThemeProvider>
			</body>
		</html>
	);
}
