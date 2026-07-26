import { useState } from "react";
import { RadioGroup } from "radix-ui";

interface ConnectMobileSetupProps {
	/** Live bridge port, echoed in the Tailscale manual-entry step. */
	port: number;
	/**
	 * False while the bridge is off; the steps are then collapsed, so their
	 * controls must leave the tab order (same pattern as the pairing block).
	 */
	enabled: boolean;
}

type SetupMode = "lan" | "tailscale";

// ConnectMobileSetup tells the user what to do with the pairing QR above it.
// The LAN mode is the happy path (scan and go). The Tailscale mode is manual
// entry on purpose: the pairing QR can only ever carry the LAN address,
// because AutopickLANIP skips utun* interfaces and rejects Tailscale's
// 100.64.0.0/10 CGNAT range as non-private (backend/internal/mobilebridge/netiface.go).
export function ConnectMobileSetup({ port, enabled }: ConnectMobileSetupProps) {
	const [mode, setMode] = useState<SetupMode>("lan");

	// Margin-free on purpose: the modal owns the spacing around this block.
	return (
		<div className="flex w-full flex-col items-center">
			<RadioGroup.Root
				value={mode}
				onValueChange={(value) => setMode(value as SetupMode)}
				aria-label="Connection method"
				className="settings-segment"
			>
				<RadioGroup.Item value="lan" tabIndex={enabled ? 0 : -1} className="settings-segment-item">
					LAN
				</RadioGroup.Item>
				<RadioGroup.Item value="tailscale" tabIndex={enabled ? 0 : -1} className="settings-segment-item">
					Tailscale
				</RadioGroup.Item>
			</RadioGroup.Root>

			{mode === "lan" ? (
				<div className="mt-3 w-full px-(--size-settings-mobile-details-pad-x)">
					<ol className="settings-mobile-steps">
						<li>Put your phone on the same Wi-Fi as this computer.</li>
						<li>Open Agent Orchestrator on your phone and tap Scan.</li>
						<li>Scan the code below — address and password fill in automatically.</li>
					</ol>
				</div>
			) : (
				<div className="mt-3 w-full px-(--size-settings-mobile-details-pad-x)">
					<ol className="settings-mobile-steps">
						<li>Install Tailscale here and on your phone, signed into the same account.</li>
						<li>
							Run <span className="tracking-settings-mono text-settings-label">tailscale ip -4</span> here to get your
							100.x address.
						</li>
						<li>In the app's Settings, enter that address, port {port}, and the password below. Leave Use TLS off.</li>
					</ol>
				</div>
			)}
		</div>
	);
}
