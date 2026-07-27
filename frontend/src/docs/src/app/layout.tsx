import { GeistSans } from "geist/font/sans";
import { IBM_Plex_Mono } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { COMPANY } from "../../../landing/packages/shared/src/constants";
import "./global.css";

const ibmPlexMono = IBM_Plex_Mono({
  weight: ["300", "400", "500"],
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(COMPANY.MARKETING_URL),
  icons: {
    icon: [{ url: `${COMPANY.MARKETING_URL}/favicon.svg`, type: "image/svg+xml" }],
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark overscroll-none ${ibmPlexMono.variable} ${GeistSans.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <RootProvider
          theme={{ enabled: false }}
          search={{
            options: {
              type: "static",
              api: "/api/search",
            },
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
