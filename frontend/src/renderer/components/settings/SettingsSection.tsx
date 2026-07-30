import type { ReactNode } from "react";

/**
 * Figma section: column, gap 12px between heading and rows.
 * `sectionId` (optional) marks the section for the renderer smoke suite as
 * [data-testid="settings-section"][data-section=<id>].
 */
export function SettingsSection({
	title,
	sectionId,
	titleHidden = false,
	children,
}: {
	title: string;
	sectionId?: string;
	/** The settings dialog already names the open page; hide the duplicate heading but keep it for assistive tech. */
	titleHidden?: boolean;
	children: ReactNode;
}) {
	return (
		<section
			className="flex w-full flex-col items-stretch gap-(--size-settings-section-inner-gap)"
			data-testid={sectionId ? "settings-section" : undefined}
			data-section={sectionId}
		>
			<h2
				className={
					titleHidden
						? "sr-only"
						: "px-(--size-settings-row-padding) text-xs font-semibold leading-4 tracking-tight text-settings-muted"
				}
			>
				{title}
			</h2>
			<div className="flex w-full flex-col gap-1.5">{children}</div>
		</section>
	);
}
