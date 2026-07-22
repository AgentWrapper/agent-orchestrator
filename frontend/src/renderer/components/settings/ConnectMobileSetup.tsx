import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

interface ConnectMobileSetupProps {
	/** Live bridge port, echoed in the Tailscale manual-entry step. */
	port: number;
	/**
	 * False while the bridge is off; the steps are then collapsed, so their
	 * tabs must leave the tab order (same pattern as the pairing block).
	 */
	enabled: boolean;
}

const stepListClass =
	"list-decimal space-y-1.5 pl-4 text-caption leading-(--leading-settings-mobile-hint) text-settings-muted";

const triggerClass = "text-settings-muted data-[state=active]:bg-settings-row data-[state=active]:text-settings-title";

// ConnectMobileSetup tells the user what to do with the pairing QR above it.
// The LAN tab is the happy path (scan and go). The Tailscale tab is manual
// entry on purpose: the pairing QR can only ever carry the LAN address,
// because AutopickLANIP skips utun* interfaces and rejects Tailscale's
// 100.64.0.0/10 CGNAT range as non-private (backend/internal/mobilebridge/netiface.go).
export function ConnectMobileSetup({ port, enabled }: ConnectMobileSetupProps) {
	// Margin-free on purpose: the modal owns the spacing around this block.
	return (
		<Tabs defaultValue="lan" className="flex w-full flex-col items-center">
			<TabsList className="bg-[var(--color-bg-settings-input)]">
				<TabsTrigger value="lan" tabIndex={enabled ? 0 : -1} className={triggerClass}>
					LAN
				</TabsTrigger>
				<TabsTrigger value="tailscale" tabIndex={enabled ? 0 : -1} className={triggerClass}>
					Tailscale
				</TabsTrigger>
			</TabsList>

			<TabsContent value="lan" className="mt-3 w-full px-(--size-settings-mobile-details-pad-x)">
				<ol className={stepListClass}>
					<li>Put your phone on the same Wi-Fi as this computer.</li>
					<li>Open Agent Orchestrator on your phone and tap Scan.</li>
					<li>Scan the code below — address and password fill in automatically.</li>
				</ol>
			</TabsContent>

			<TabsContent value="tailscale" className="mt-3 w-full px-(--size-settings-mobile-details-pad-x)">
				<ol className={stepListClass}>
					<li>Install Tailscale here and on your phone, signed into the same account.</li>
					<li>
						Run <span className="tracking-settings-mono text-settings-label">tailscale ip -4</span> here to get your
						100.x address.
					</li>
					<li>In the app's Settings, enter that address, port {port}, and the password below. Leave Use TLS off.</li>
				</ol>
			</TabsContent>
		</Tabs>
	);
}
