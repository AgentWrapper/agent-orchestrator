import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Figma "Settings Container": centered column, max-width 768px,
 * padding 64px 32px 80px, gap 32px between header and sections.
 */
export function SettingsPanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
	return (
		<div className="flex h-full min-h-0 w-full justify-center overflow-y-auto" aria-label="Settings">
			<div className="flex w-full max-w-(--size-settings-content-width) flex-col items-stretch gap-(--size-settings-section-gap) px-(--size-settings-panel-padding-x) pb-(--size-settings-panel-padding-bottom) pt-(--size-settings-panel-padding-top)">
				<div className="flex shrink-0 items-start justify-between gap-4 self-stretch">
					<h1 className="text-settings-heading font-bold text-settings-title">Settings</h1>
					<button type="button" onClick={onClose} className="settings-close-button" aria-label="Close settings">
						<X className="size-5" aria-hidden="true" strokeWidth={2.25} />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
