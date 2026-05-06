export interface GitHubRepoStats {
  stars: number;
  forks: number;
  openIssues: number;
  watchers: number;
}

const FALLBACK_STATS: GitHubRepoStats = {
  stars: 6295,
  forks: 853,
  openIssues: 622,
  watchers: 21,
};

export async function getGitHubRepoStats(): Promise<GitHubRepoStats> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/ComposioHQ/agent-orchestrator",
      {
        next: { revalidate: 3600 },
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ao-website",
        },
      },
    );

    if (!response.ok) {
      return FALLBACK_STATS;
    }

    const data = (await response.json()) as {
      stargazers_count?: number;
      forks_count?: number;
      open_issues_count?: number;
      subscribers_count?: number;
    };

    return {
      stars: data.stargazers_count ?? FALLBACK_STATS.stars,
      forks: data.forks_count ?? FALLBACK_STATS.forks,
      openIssues: data.open_issues_count ?? FALLBACK_STATS.openIssues,
      watchers: data.subscribers_count ?? FALLBACK_STATS.watchers,
    };
  } catch {
    return FALLBACK_STATS;
  }
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}
