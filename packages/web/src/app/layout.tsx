import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { getProjectName } from "@/lib/project-name";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/app/providers";
import "./globals.css";

// "Quiet instrument" type system: a refined humanist grotesk for UI, paired
// with JetBrains Mono for IDs, data, and the terminal. Wired to the existing
// --font-geist-sans / --font-jetbrains-mono CSS vars via globals.css.
const uiSans = Hanken_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui-sans",
  weight: ["400", "500", "600", "700"],
});

const uiMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-ui-mono",
  weight: ["400", "500", "600"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return {
    title: {
      template: `%s | ${projectName}`,
      default: `ao | ${projectName}`,
    },
    description: "Dashboard for managing parallel AI coding agents",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: `ao | ${projectName}`,
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${uiSans.variable} ${uiMono.variable}`}
      suppressHydrationWarning
    >
      <body className="h-screen overflow-hidden bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <Providers>{children}</Providers>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
