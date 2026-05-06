import type { PRInfo } from "../types.js";

export type ParsedPrUrl = Pick<PRInfo, "owner" | "repo" | "number" | "url">;

const TRAILING_NUMBER_REGEX = /\/(\d+)$/;

export function parsePrFromUrl(prUrl: string): ParsedPrUrl | null {
  const parsedUrl = tryParseUrl(prUrl);
  const pathSegments = parsedUrl?.pathname.split("/").filter(Boolean) ?? [];

  const githubStylePullIndex = pathSegments.findIndex((segment) => segment === "pull");
  if (githubStylePullIndex >= 2 && githubStylePullIndex + 1 < pathSegments.length) {
    const owner = pathSegments[githubStylePullIndex - 2];
    const repo = pathSegments[githubStylePullIndex - 1];
    const prNumber = pathSegments[githubStylePullIndex + 1];
    if (owner && repo && prNumber && /^\d+$/.test(prNumber)) {
      return {
        owner,
        repo,
        number: Number.parseInt(prNumber, 10),
        url: prUrl,
      };
    }
  }

  const gitlabMergeRequestIndex = pathSegments.findIndex(
    (segment, index) =>
      segment === "-" &&
      pathSegments[index + 1] === "merge_requests" &&
      index >= 2 &&
      index + 2 < pathSegments.length,
  );
  if (gitlabMergeRequestIndex >= 2) {
    const owner = pathSegments[gitlabMergeRequestIndex - 2];
    const repo = pathSegments[gitlabMergeRequestIndex - 1];
    const prNumber = pathSegments[gitlabMergeRequestIndex + 2];
    if (owner && repo && prNumber && /^\d+$/.test(prNumber)) {
      return {
        owner,
        repo,
        number: Number.parseInt(prNumber, 10),
        url: prUrl,
      };
    }
  }

  const trailingNumberMatch = prUrl.match(TRAILING_NUMBER_REGEX);
  if (trailingNumberMatch) {
    return {
      owner: "",
      repo: "",
      number: parseInt(trailingNumberMatch[1], 10),
      url: prUrl,
    };
  }

  return null;
}

function tryParseUrl(prUrl: string): URL | null {
  try {
    return new URL(prUrl);
  } catch {
    return null;
  }
}
