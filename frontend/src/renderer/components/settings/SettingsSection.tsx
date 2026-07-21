import type { ReactNode } from "react";

/** Figma section: column, gap 12px between heading and rows. */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex w-full flex-col items-stretch gap-(--size-settings-section-inner-gap)">
			<h2 className="text-xs font-bold uppercase leading-4 tracking-settings-section text-settings-muted">{title}</h2>
			<div className="flex w-full flex-col gap-1.5">{children}</div>
		</section>
	);
}
