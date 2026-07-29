import { useEffect, useState } from "react";
import aoLogo from "../../../assets/ao-logo.svg";

const STARTUP_PHRASES = [
	"Starting local services",
	"Connecting to the daemon",
	"Loading workspaces",
	"Preparing your board",
] as const;

const PHRASE_INTERVAL_MS = 2_200;

export function DaemonStartupLoader() {
	const [phraseIndex, setPhraseIndex] = useState(0);

	useEffect(() => {
		const timer = window.setInterval(() => {
			setPhraseIndex((current) => (current + 1) % STARTUP_PHRASES.length);
		}, PHRASE_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, []);

	const phrase = STARTUP_PHRASES[phraseIndex];

	return (
		<div
			aria-busy="true"
			aria-label="Agent Orchestrator is starting"
			aria-live="polite"
			className="ao-startup-screen flex h-full w-full items-center justify-center bg-background text-foreground"
			data-testid="daemon-startup-loader"
			role="status"
		>
			<div className="ao-startup-content flex -translate-y-[3vh] flex-col items-center text-center">
				<div className="grid h-28 w-32 place-items-center" aria-hidden="true">
					<img className="ao-startup-logo h-22 w-25 object-contain" src={aoLogo} alt="" />
				</div>
				<p className="mt-5 text-base font-semibold tracking-tight text-foreground">Agent Orchestrator</p>
				<p className="mt-2 min-h-5 text-md-sm text-muted-foreground">
					<span aria-hidden="true" className="ao-startup-status" key={phrase}>
						{phrase}
					</span>
				</p>
				<div className="ao-startup-dots mt-3 flex h-4 items-center gap-1.5" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
			</div>
		</div>
	);
}
