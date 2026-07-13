import { Logo } from "./Logo";
import { DESKTOP_DOWNLOADS, RELEASE_URL } from "../../lib/desktop-downloads";

export function InstallDownloads() {
	return (
		<section className="ao-install-downloads" aria-label="Download Agent Orchestrator">
			<div className="ao-install-downloads__header">
				<div className="ao-install-downloads__copy">
					<div className="ao-install-downloads__title">Choose your platform</div>
				</div>
				<a className="ao-install-downloads__release" href={RELEASE_URL}>
					View release
				</a>
			</div>

			<div className="ao-install-downloads__grid">
				{DESKTOP_DOWNLOADS.map((download) => (
					<a
						key={`${download.platform}-${download.detail}`}
						className="ao-install-downloads__item"
						href={download.href}
					>
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
				No CLI required. Already using npm? See <a href="#start-ao-in-a-repo">Start AO in a repo</a>.
			</div>
		</section>
	);
}
