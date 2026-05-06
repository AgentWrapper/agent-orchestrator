import type { MetadataRoute } from "next";
import { getProjectName } from "@/lib/project-name";

export default function manifest(): MetadataRoute.Manifest {
  const projectName = getProjectName();
  return {
    name: `ao | ${projectName}`,
    short_name: "ao",
    description: "Dashboard for managing parallel AI coding agents",
    start_url: "/",
    display: "standalone",
    background_color: "#121110",
    theme_color: "#121110",
    icons: [
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
