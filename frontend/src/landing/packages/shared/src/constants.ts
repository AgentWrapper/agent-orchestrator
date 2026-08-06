export const COMPANY = {
  NAME: "Agent Orchestrator",
  SHORT_NAME: "AO",
  MARKETING_URL: "https://aoagents.dev",
  DOCS_URL: "https://aoagents.dev/docs",
  GITHUB_URL: "https://github.com/Untrivial-ai/agent-orchestrator",
  GITHUB_REPO: "Untrivial-ai/agent-orchestrator",
  STATUS_URL: "https://status.aoagents.dev",
  TRUST_URL: "https://aoagents.dev/privacy/",
  MAIL_TO: "mailto:prateek@untrivial.ai",
  X_URL: "https://x.com/aoagents",
  LINKEDIN_URL: "https://www.linkedin.com/company/agent-orchestrator/",
  DISCORD_URL: "https://discord.com/invite/UZv7JjxbwG",
  FOUNDERS_EMAIL: "prateek@untrivial.ai",
  REPORT_ISSUE_URL: "https://github.com/Untrivial-ai/agent-orchestrator/issues/new",
  LICENSE: "Apache-2.0",
  LICENSE_URL: "https://github.com/Untrivial-ai/agent-orchestrator/blob/main/LICENSE",
} as const;

export const THEME_STORAGE_KEY = "ao-theme";
export const POSTHOG_COOKIE_NAME = "ph_phc_";

export const OPEN_ROLES = [] as { title: string; url: string; location: string }[];

export const PLATFORMS = {
  MACOS: "macos",
  WINDOWS: "windows",
  LINUX: "linux",
} as const;

export const GITHUB_STARS_URL = "https://api.github.com/repos/Untrivial-ai/agent-orchestrator";

// macOS still points at the .zip on purpose. The .dmg first-install artifact is
// built by frontend/makers/maker-dmg.ts, but no published release carries it yet,
// so flipping these two links (and the two macOS rows in README.md) to
// "...-darwin-{arch}.dmg" would 404 until a real release publishes both formats.
// That flip is rollout step 6 in issue #3267 and must happen only after a real
// release has been cut and the dmg verified. The .zip keeps publishing forever
// either way, because electron-updater cannot auto-update from a .dmg.
export const DOWNLOAD_URL_MAC_ARM64 = "https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-arm64.zip";
export const DOWNLOAD_URL_MAC_X64 = "https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-darwin-x64.zip";
export const DOWNLOAD_URL_WINDOWS = "https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-win32-x64.exe";
export const DOWNLOAD_URL_LINUX = "https://github.com/Untrivial-ai/agent-orchestrator/releases/latest/download/agent-orchestrator-linux-x64.AppImage";

// AO Mobile. iOS ships as a TestFlight beta — the same link the desktop app's
// Connect Mobile panel opens (frontend/src/renderer/components/settings/
// ConnectMobileGetApp.tsx), so the two must be changed together. Android is on
// its way to Play (see docs/android-play-setup.md) and has no public link yet.
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/t4U3fu2H";

/** Apple's TestFlight app itself — step one, and useless to skip. */
export const TESTFLIGHT_APP_URL = "https://apps.apple.com/app/testflight/id899247664";

export const AGENT_HARNESSES = 24;
export const TAGLINE = "Stop babysitting agents. Start merging real work.";
export const HERO_SUBHEADLINE = "Run a fleet of coding agents while keeping branches, reviews, and CI failures manageable.";
export const HERO_SECONDARY_SUBHEADLINE = "Isolated workspaces for Claude Code, Codex, and any CLI agent. Review every change from one dashboard. Free and open source.";

export const NAV_ITEMS = [
  { label: "Demo", href: "/#see-it" },
  { label: "Features", href: "/#features" },
  { label: "Changelog", href: "/changelog" },
  { label: "Docs", href: "/docs" },
] as const;
