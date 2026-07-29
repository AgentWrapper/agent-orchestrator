"use client";

import type { CSSProperties, ReactNode } from "react";

export const featurePreviewTokens = {
	"--preview-background": "oklch(0.153 0.006 107.1)",
	"--preview-foreground": "oklch(0.988 0.003 106.5)",
	"--preview-card": "oklch(0.228 0.013 107.4)",
	"--preview-card-foreground": "oklch(0.988 0.003 106.5)",
	"--preview-primary": "oklch(0.93 0.007 106.5)",
	"--preview-primary-foreground": "oklch(0.228 0.013 107.4)",
	"--preview-muted": "oklch(0.286 0.016 107.4)",
	"--preview-muted-foreground": "oklch(0.737 0.021 106.9)",
	"--preview-accent": "#7eaaff",
	"--preview-border": "oklch(1 0 0 / 10%)",
	"--preview-ring": "oklch(0.58 0.031 107.3)",
} as CSSProperties;

export const previewStatus = {
	working: "#f59f4c",
	warning: "#e8c14a",
	success: "#74b98a",
	error: "#ef6b73",
	accent: "#7eaaff",
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
			className={`mx-auto w-full min-w-0 max-w-[570px] overflow-hidden rounded-xl border border-[var(--preview-border)] bg-[var(--preview-background)] font-sans text-[var(--preview-foreground)] antialiased shadow-[0_24px_64px_-20px_rgba(0,0,0,0.8)] ${className}`}
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
