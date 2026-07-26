"use client";

import type { CSSProperties, ReactNode } from "react";

export const featurePreviewTokens = {
	"--preview-background": "#0a0b0d",
	"--preview-foreground": "#f4f5f7",
	"--preview-card": "#15171b",
	"--preview-card-foreground": "#f4f5f7",
	"--preview-primary": "#2e63b8",
	"--preview-primary-foreground": "#ffffff",
	"--preview-muted": "#1b1d22",
	"--preview-muted-foreground": "#9ba1aa",
	"--preview-accent": "#4d8dff",
	"--preview-border": "rgb(255 255 255 / 0.06)",
	"--preview-border-strong": "rgb(255 255 255 / 0.1)",
	"--preview-ring": "#4d8dff",
} as CSSProperties;

export const previewStatus = {
	working: "#36c2b4",
	warning: "#f2b84b",
	success: "#9ad97a",
	error: "#ee6a6a",
	accent: "#4d8dff",
} as const;

export function FeaturePreviewShell({
	children,
	className = "",
	title,
	trailing,
}: {
	children: ReactNode;
	className?: string;
	title: string;
	trailing?: ReactNode;
}) {
	return (
		<div
			className={`mx-auto w-full min-w-0 max-w-[570px] overflow-hidden rounded-[20px] border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] antialiased shadow-[0_24px_64px_-20px_rgba(0,0,0,0.8)] ${className}`}
			style={featurePreviewTokens}
		>
			<div className="flex h-9 items-center border-b border-[var(--preview-border)] bg-[var(--preview-background)] px-3">
				<div className="flex items-center gap-1.5" aria-hidden="true">
					<span className="size-2.5 rounded-full bg-[#ff5f57]" />
					<span className="size-2.5 rounded-full bg-[#ffbd2e]" />
					<span className="size-2.5 rounded-full bg-[#28c840]" />
				</div>
				<div className="ml-4 flex min-w-0 items-center gap-2">
					<img src="/ao-logo.svg" alt="" className="size-4" draggable="false" />
					<span className="truncate text-[11px] font-semibold tracking-[-0.4px] text-[var(--preview-muted-foreground)]">
						{title}
					</span>
				</div>
				{trailing ? <div className="ml-auto hidden shrink-0 min-[420px]:block">{trailing}</div> : null}
			</div>
			{children}
		</div>
	);
}

export function StatusDot({
	color,
	pulse = false,
}: {
	color: string;
	pulse?: boolean;
}) {
	return (
		<span className="relative flex size-2 shrink-0">
			{pulse ? (
				<span
					className="absolute inline-flex size-full animate-ping rounded-full opacity-40"
					style={{ backgroundColor: color }}
				/>
			) : null}
			<span
				className="relative inline-flex size-2 rounded-full"
				style={{ backgroundColor: color }}
			/>
		</span>
	);
}
