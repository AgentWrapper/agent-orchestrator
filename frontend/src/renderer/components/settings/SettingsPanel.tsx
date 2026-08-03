import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useEffect, type ReactNode } from "react";
import { isDialogOrMenuOpen } from "../../lib/dom-selectors";

/**
 * Figma "Settings Container": centered column, max-width 768px,
 * padding 64px 32px 80px, gap 32px between header and sections.
 */
export function SettingsPanel({
	children,
	onClose,
	subtitle,
}: {
	children: ReactNode;
	onClose: () => void;
	/** Optional path or context shown beside the title (project settings). */
	subtitle?: string;
}) {
	const { t } = useTranslation();
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || isDialogOrMenuOpen()) return;
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div
			className="flex h-full min-h-0 w-full justify-center overflow-y-auto"
			aria-label={t("settings.title")}
			// Stable hook for the renderer smoke suite (settings page mounted).
			data-testid="settings-page"
		>
			<div className="flex w-full max-w-(--size-settings-content-width) flex-col items-stretch gap-(--size-settings-section-gap) px-(--size-settings-panel-padding-x) pb-(--size-settings-panel-padding-bottom) pt-(--size-settings-panel-padding-top)">
				<div className="flex shrink-0 items-start justify-between gap-4 self-stretch">
					<div className="flex min-w-0 items-baseline gap-3">
						<h1 className="text-settings-heading font-bold text-settings-title">{t("settings.title")}</h1>
						{subtitle ? (
							<span className="truncate font-mono text-md-sm text-settings-muted" title={subtitle}>
								{subtitle}
							</span>
						) : null}
					</div>
					<button type="button" onClick={onClose} className="settings-close-button" aria-label={t("settings.close")}>
						<X className="size-5" aria-hidden="true" strokeWidth={2.25} />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
