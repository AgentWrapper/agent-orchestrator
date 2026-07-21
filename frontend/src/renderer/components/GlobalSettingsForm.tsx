import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Mail } from "lucide-react";
// import { aoBridge } from "../lib/bridge";
// import { SETTINGS_SOCIAL_LINKS } from "../lib/social-links";
import { ConnectMobileModal } from "./ConnectMobileModal";
import { GeneralSettingsSection } from "./settings/GeneralSettingsSection";
import { ReportProblemDialog } from "./settings/ReportProblemDialog";
import { SettingsLinkRow } from "./settings/SettingsRow";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { SettingsPanel } from "./settings/SettingsPanel";
import { SettingsSection } from "./settings/SettingsSection";
import { UpdatesSection } from "./settings/UpdatesSection";

// const SOCIAL_ICONS: Record<(typeof SETTINGS_SOCIAL_LINKS)[number]["id"], ComponentType<SVGProps<SVGSVGElement>>> = {
// 	linkedin: LinkedInIcon,
// 	twitter: XSocialIcon,
// };

export function GlobalSettingsForm() {
	const navigate = useNavigate();
	const [mobileOpen, setMobileOpen] = useState(false);
	const [feedbackOpen, setFeedbackOpen] = useState(false);

	return (
		<>
			<SettingsPageShell>
				<SettingsPanel onClose={() => navigate({ to: "/" })}>
					<GeneralSettingsSection onConnectMobile={() => setMobileOpen(true)} />
					<UpdatesSection />
					<SettingsSection title="Get help">
						<SettingsLinkRow icon={Mail} label="Feedback" onClick={() => setFeedbackOpen(true)} />
					</SettingsSection>
					{/* Connect with us — temporarily disabled
					<SettingsSection title="CONNECT WITH US">
						<div className="flex flex-wrap items-center gap-x-(--size-settings-social-gap-x) gap-y-3 pl-4">
							{SETTINGS_SOCIAL_LINKS.map(({ id, label, href }) => {
								const Icon = SOCIAL_ICONS[id];
								return (
									<a
										key={id}
										href={href}
										target="_blank"
										rel="noopener noreferrer"
										onClick={(event) => {
											event.preventDefault();
											void aoBridge.app.openExternal(href);
										}}
										className="inline-flex items-center gap-2.5 text-settings-label"
									>
										<span className="inline-flex size-(--size-settings-social-icon) shrink-0 items-center justify-center">
											<Icon className="block size-full" aria-hidden="true" />
										</span>
										<span className="text-sm leading-5">{label}</span>
									</a>
								);
							})}
						</div>
					</SettingsSection>
					*/}
				</SettingsPanel>
			</SettingsPageShell>
			<ConnectMobileModal open={mobileOpen} onOpenChange={setMobileOpen} />
			<ReportProblemDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
		</>
	);
}

// function LinkedInIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
// 	return (
// 		<svg
// 			viewBox="0 0 24 24"
// 			fill="currentColor"
// 			className={cn("size-(--size-settings-social-icon)", className)}
// 			{...props}
// 		>
// 			<path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45ZM22.23 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.73V1.73C24 .77 23.21 0 22.23 0Z" />
// 		</svg>
// 	);
// }
//
// function XSocialIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
// 	return (
// 		<svg
// 			viewBox="0 0 24 24"
// 			fill="currentColor"
// 			className={cn("size-(--size-settings-social-icon)", className)}
// 			{...props}
// 		>
// 			<path d="M18.9 2.25h3.24l-7.08 8.09 8.33 11.41h-6.52l-5.11-6.91-5.84 6.91H2.66l7.57-8.67L2.25 2.25h6.69l4.62 6.3 5.34-6.3Zm-1.14 17.5h1.8L7.96 4.14H6.03l11.73 15.61Z" />
// 		</svg>
// 	);
// }
