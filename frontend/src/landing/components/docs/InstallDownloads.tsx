import { Logo } from "./Logo";

const RELEASE_BASE = "https://github.com/AgentWrapper/agent-orchestrator/releases/latest";

const DOWNLOADS = [
	{
		platform: "macOS",
		detail: "Apple silicon",
		logo: "apple",
		type: ".zip",
		href: `${RELEASE_BASE}/download/agent-orchestrator-darwin-arm64.zip`,
	},
	{
		platform: "macOS",
		detail: "Intel",
		logo: "apple",
		type: ".zip",
		href: `${RELEASE_BASE}/download/agent-orchestrator-darwin-x64.zip`,
	},
	{
		platform: "Windows",
		detail: "x64 installer",
		logo: "windows",
		type: ".exe",
		href: `${RELEASE_BASE}/download/agent-orchestrator-win32-x64.exe`,
	},
	{
		platform: "Linux",
		detail: "x64 AppImage",
		logo: "linux",
		type: ".AppImage",
		href: `${RELEASE_BASE}/download/agent-orchestrator-linux-x64.AppImage`,
	},
];

export function InstallDownloads() {
	return (
		<section className="ao-install-downloads" aria-label="Download Agent Orchestrator">
			<div className="ao-install-downloads__header">
				<div className="ao-install-downloads__copy">
					<div className="ao-install-downloads__eyebrow">Manual downloads</div>
					<div className="ao-install-downloads__title">Latest desktop release assets</div>
					<div className="ao-install-downloads__description">
						Use these direct links if you prefer to install without the terminal bootstrap script.
					</div>
				</div>
				<a className="ao-install-downloads__release" href={RELEASE_BASE}>
					Latest release
				</a>
			</div>

			<div className="ao-install-downloads__grid">
				{DOWNLOADS.map((download) => (
					<a key={`${download.platform}-${download.detail}`} className="ao-install-downloads__item" href={download.href}>
						<span className="ao-install-downloads__icon">
							<Logo name={download.logo} size={20} />
						</span>
						<span className="ao-install-downloads__meta">
							<span className="ao-install-downloads__platform">{download.platform}</span>
							<span className="ao-install-downloads__detail">{download.detail}</span>
						</span>
						<span className="ao-install-downloads__type">{download.type}</span>
					</a>
				))}
			</div>

			<div className="ao-install-downloads__note">
				Open the app after downloading, then continue to{" "}
				<a href="#authenticate-your-tools">Authenticate Your Tools</a>.
			</div>
		</section>
	);
}
