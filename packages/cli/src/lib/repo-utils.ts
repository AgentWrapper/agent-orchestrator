/**
 * Shared utilities for repository detection and validation.
 */

/**
 * Regex to extract owner/repo (or group/subgroup/repo) from GitHub/GitLab remotes.
 * Supports both HTTPS and SSH formats, and GitLab subgroup paths.
 */
const REMOTE_REPO_REGEX = /(?:github|gitlab)\.com[:/](.+?)(?:\.git)?$/;

/**
 * Extract owner/repo from a git remote URL.
 * Returns null if the remote doesn't match a known host (github.com, gitlab.com).
 */
export function extractOwnerRepo(gitRemote: string): string | null {
  const match = gitRemote.match(REMOTE_REPO_REGEX);
  return match ? match[1] : null;
}

/**
 * Validate a user-entered repo string.
 * Accepts "owner/repo" and "group/subgroup/repo" formats.
 * Rejects empty strings, strings with whitespace, and strings without at least one slash.
 */
export const REPO_VALIDATION_REGEX = /^[^\s/]+(?:\/[^\s/]+)+$/;

export function isValidRepoString(value: string): boolean {
  return REPO_VALIDATION_REGEX.test(value);
}
