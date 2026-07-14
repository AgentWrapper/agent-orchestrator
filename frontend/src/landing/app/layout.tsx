import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { HomeScrollReset } from "@/components/HomeScrollReset";
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

const themeScript = `
(() => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.classList.add("dark");
  document.documentElement.style.colorScheme = "dark";
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html
			lang="en"
			suppressHydrationWarning
			className={`${inter.variable} ${inter.className} dark`}
			data-theme="dark"
			style={{ colorScheme: "dark" }}
		>
			<head>
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
			</head>
			<body className={`${inter.variable} ${inter.className} font-sans`}>
				<HomeScrollReset />
				{children}
			</body>
		</html>
	);
}
