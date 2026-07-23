import { QrCode } from "lucide-react";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";

/** TestFlight beta for the Agent Orchestrator iOS app. */
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/t4U3fu2H";

/** Deliberately smaller than the pairing QR so it never competes with it. */
const TESTFLIGHT_QR_SIZE = 140;

// ConnectMobileGetApp is step zero of pairing: the pairing QR below it is
// meaningless until the app is installed. It sits outside the modal's
// enable-collapse because installing the app has nothing to do with whether
// the LAN bridge is running. The QR (of the TestFlight URL itself) hides
// behind a disclosure so the widened modal keeps its height.
export function ConnectMobileGetApp() {
	const [showQR, setShowQR] = useState(false);

	return (
		<div className="mt-6 flex flex-col rounded-(--radius-settings-dialog-lg) border border-[var(--color-border-settings-input)] bg-[var(--color-bg-settings-input)] px-3.5 py-3">
			<span className="text-subtitle leading-(--leading-settings-mobile-title) text-settings-label">Get the app</span>

			{/* iOS — items-center so the action cluster sits on the row's optical centre. */}
			<div className="mt-2.5 flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col">
					<span className="text-sm leading-5 text-settings-label">iOS</span>
					<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
						Install Apple's TestFlight app first, then join the beta
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						aria-label="Join the TestFlight beta"
						onClick={() => void aoBridge.app.openExternal(TESTFLIGHT_URL)}
						className="inline-flex h-7 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border-settings-input)] bg-settings-row px-3 text-caption text-settings-label transition-opacity hover:opacity-90"
					>
						Join beta
					</button>
					<button
						type="button"
						aria-label={showQR ? "Hide TestFlight QR code" : "Show TestFlight QR code"}
						aria-expanded={showQR}
						onClick={() => setShowQR((v) => !v)}
						className={cn(
							"inline-flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-settings-row",
							showQR ? "bg-settings-row text-settings-title" : "text-settings-muted",
						)}
					>
						<QrCode className="size-4" aria-hidden="true" />
					</button>
				</div>
			</div>

			<div
				data-testid="testflight-qr"
				className={cn(
					"grid transition-[grid-template-rows] duration-300 ease-out",
					showQR ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
				)}
				aria-hidden={!showQR}
			>
				<div className="overflow-hidden">
					<div
						className={cn(
							"flex flex-col items-center pt-3 transition-opacity duration-300 ease-out",
							showQR ? "opacity-100" : "opacity-0",
						)}
					>
						<div className="rounded-xl bg-white p-2 shadow-[var(--shadow-settings-qr)]">
							<QRCodeSVG value={TESTFLIGHT_URL} size={TESTFLIGHT_QR_SIZE} className="block" />
						</div>
						<p className="mt-2 text-caption text-settings-muted">Install TestFlight, then scan to join the beta</p>
					</div>
				</div>
			</div>

			{/* Android — no build to hand out yet, so this row is informational only. */}
			<div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--color-border-settings-input)] pt-3">
				<div className="flex min-w-0 flex-col">
					<span className="text-sm leading-5 text-settings-label">Android</span>
					<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
						Play Store beta
					</span>
				</div>
				<span className="inline-flex h-7 shrink-0 items-center rounded-lg bg-settings-row px-3 text-caption text-settings-muted">
					Coming soon
				</span>
			</div>
		</div>
	);
}
