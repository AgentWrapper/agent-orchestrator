export const RELEASE_URL = "https://github.com/AgentWrapper/agent-orchestrator/releases/latest";

export const DESKTOP_DOWNLOADS = [
	{
		platform: "macOS",
		detail: "Apple silicon",
		label: "macOS (Apple silicon)",
		logo: "apple",
		type: "Download .zip",
		href: `${RELEASE_URL}/download/agent-orchestrator-darwin-arm64.zip`,
	},
	{
		platform: "macOS",
		detail: "Intel",
		label: "macOS (Intel)",
		logo: "apple",
		type: "Download .zip",
		href: `${RELEASE_URL}/download/agent-orchestrator-darwin-x64.zip`,
	},
	{
		platform: "Windows",
		detail: "x64 installer",
		label: "Windows",
		logo: "windows",
		type: "Download .exe",
		href: `${RELEASE_URL}/download/agent-orchestrator-win32-x64.exe`,
	},
	{
		platform: "Linux",
		detail: "x64 AppImage",
		label: "Linux",
		logo: "linux",
		type: "Download .AppImage",
		href: `${RELEASE_URL}/download/agent-orchestrator-linux-x64.AppImage`,
	},
] as const;

type PlatformNavigator = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent">;

function platformDescription(navigator: PlatformNavigator): string {
	return `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
}

export function isPortableDevice(navigator: PlatformNavigator): boolean {
	const platform = platformDescription(navigator);
	return (
		/android|iphone|ipad|ipod|mobile|tablet/.test(platform) ||
		(platform.includes("mac") && navigator.maxTouchPoints > 1)
	);
}

export function getDownloadTarget(navigator: PlatformNavigator) {
	const platform = platformDescription(navigator);

	if (isPortableDevice(navigator)) return null;
	if (platform.includes("win")) return { label: "Download for Windows", href: DESKTOP_DOWNLOADS[2].href };
	if (platform.includes("linux") || platform.includes("x11"))
		return { label: "Download for Linux", href: DESKTOP_DOWNLOADS[3].href };
	return null;
}

export function getDownloadOptions(navigator: PlatformNavigator) {
	const platform = platformDescription(navigator);
	return platform.includes("mac") && !isPortableDevice(navigator) ? DESKTOP_DOWNLOADS.slice(0, 2) : DESKTOP_DOWNLOADS;
}
