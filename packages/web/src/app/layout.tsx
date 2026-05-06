import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { getProjectName } from "@/lib/project-name";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/app/providers";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3f0" },
    { media: "(prefers-color-scheme: dark)", color: "#121110" },
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
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="h-screen overflow-hidden bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <Providers>{children}</Providers>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
