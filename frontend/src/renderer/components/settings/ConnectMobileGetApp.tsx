import { QrCode } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { aoBridge } from "../../lib/bridge";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/** TestFlight beta for the Agent Orchestrator iOS app. */
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/t4U3fu2H";

/** Android internal-testing signup form. */
export const ANDROID_SIGNUP_URL = "https://forms.gle/pWLWoxTPXySAN4Ws8";

/** Deliberately smaller than the pairing QR so it never competes with it. */
const TESTFLIGHT_QR_SIZE = 140;

// ConnectMobileGetApp is step zero of pairing: the pairing QR below it is
// meaningless until the app is installed. It sits outside the modal's
// enable-collapse because installing the app has nothing to do with whether
// the LAN bridge is running. The QR (of the TestFlight URL itself) hides
// behind a disclosure so the widened modal keeps its height.
export function ConnectMobileGetApp() {
	const { t } = useTranslation();
	const [showQR, setShowQR] = useState(false);

	return (
		<div className="flex flex-col">
			<span className="px-3 py-3 text-subtitle leading-(--leading-settings-mobile-title) text-settings-label">{t("mobile.getApp")}</span>

			{/* iOS — items-center so the action cluster sits on the row's optical centre. */}
			<div className="flex items-center justify-between gap-3 px-3 py-3">
				<div className="flex min-w-0 flex-col">
					<span className="text-sm leading-5 text-settings-label">{t("mobile.ios")}</span>
					<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
						{t("mobile.iosHint")}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button
						type="button"
						variant="footer"
						className="rounded-md"
						aria-label={t("mobile.joinTestFlightAria")}
						onClick={() => void aoBridge.app.openExternal(TESTFLIGHT_URL)}
					>
						{t("mobile.joinBeta")}
					</Button>
					<button
						type="button"
						aria-label={showQR ? t("mobile.hideQR") : t("mobile.showQR")}
						aria-expanded={showQR}
						onClick={() => setShowQR((v) => !v)}
						className={cn(
							"inline-flex size-(--size-settings-action-height) items-center justify-center rounded-md border border-transparent transition-colors hover:border-(--color-border-settings-input) hover:bg-[var(--color-bg-settings-input)]",
							showQR ? "bg-[var(--color-bg-settings-input)] text-settings-title" : "text-settings-muted",
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
				<div className="overflow-hidden px-4">
					<div
						className={cn(
							"flex flex-col items-center pt-3 transition-opacity duration-300 ease-out",
							showQR ? "opacity-100" : "opacity-0",
						)}
					>
						<div className="rounded-md border border-(--color-border-settings-input) bg-white p-2">
							<QRCodeSVG value={TESTFLIGHT_URL} size={TESTFLIGHT_QR_SIZE} className="block" />
						</div>
						<p className="mt-2 text-caption text-settings-muted">{t("mobile.qrHint")}</p>
					</div>
				</div>
			</div>

			{/* Android — internal testing signup until a Play Store beta is live. */}
			<div className="flex items-center justify-between gap-3 px-3 py-3">
				<div className="flex min-w-0 flex-col">
					<span className="text-sm leading-5 text-settings-label">{t("mobile.android")}</span>
					<span className="text-caption leading-(--leading-settings-mobile-hint) text-settings-muted">
						{t("mobile.androidHint")}
					</span>
				</div>
				<Button
					type="button"
					variant="footer"
					className="rounded-md"
					aria-label={t("mobile.androidSignupAria")}
					onClick={() => void aoBridge.app.openExternal(ANDROID_SIGNUP_URL)}
				>
					{t("mobile.joinWaitlist")}
				</Button>
			</div>
		</div>
	);
}
