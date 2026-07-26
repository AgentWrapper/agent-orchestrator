import { COMPANY } from "@superset/shared/constants";
import type { Metadata } from "next";
import dynamic from "next/dynamic";
import {
  FAQPageJsonLd,
  HomeWebPageJsonLd,
  OrganizationJsonLd,
} from "@/components/JsonLd";
import { FAQ_ITEMS } from "./components/FAQSection";
import { HeroSection } from "./components/HeroSection";

const TrustedBySection = dynamic(() =>
  import("./components/TrustedBySection").then((mod) => mod.TrustedBySection),
);
const FeaturesSection = dynamic(() =>
  import("./components/FeaturesSection").then((mod) => mod.FeaturesSection),
);
const VideoSection = dynamic(() =>
  import("./components/VideoSection").then((mod) => mod.VideoSection),
);
const WallOfLoveSection = dynamic(() =>
  import("./components/WallOfLoveSection").then((mod) => mod.WallOfLoveSection),
);
const FAQSection = dynamic(() =>
  import("./components/FAQSection").then((mod) => mod.FAQSection),
);

export const metadata: Metadata = {
  alternates: {
    canonical: COMPANY.MARKETING_URL,
  },
};

interface GitHubRepoResponse {
  stargazers_count?: number;
}

function getGitHubApiUrl() {
  const match = COMPANY.GITHUB_URL.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? `https://api.github.com/repos/${match[1]}` : null;
}

async function getGitHubStars(): Promise<number | null> {
  const apiUrl = getGitHubApiUrl();
  if (!apiUrl) return null;

  try {
    const response = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github.v3+json" },
      next: { revalidate: 3600 },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as GitHubRepoResponse;
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const stars = await getGitHubStars();

  return (
    <main className="flex flex-col bg-background">
      <FAQPageJsonLd items={FAQ_ITEMS} />
      <HomeWebPageJsonLd />
      <OrganizationJsonLd />
      <HeroSection initialStars={stars} />
      <TrustedBySection />
      <FeaturesSection />
      <VideoSection />
      <WallOfLoveSection />
      <FAQSection />
    </main>
  );
}
