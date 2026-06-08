import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getProjectName } from "@/lib/project-name";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/app/providers";
import { schibstedGrotesk, jetbrainsMono } from "@/fonts/fonts";
import "./globals.css";
// Per-screen mission-control styles, loaded after globals.css so they win on
// equal specificity (see DESIGN.md). Split per screen to keep them focused.
import "./mc-sidebar.css";
import "./mc-board.css";
import "./mc-session.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
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
      className={`dark ${schibstedGrotesk.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="h-screen overflow-hidden bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <Providers>{children}</Providers>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
