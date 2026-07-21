"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function CopyIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			aria-hidden="true"
		>
			<rect x="9" y="9" width="12" height="12" rx="2" />
			<path d="M5 15V5a2 2 0 0 1 2-2h10" />
		</svg>
	);
}

function CheckIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.2"
			aria-hidden="true"
		>
			<path d="m4 12.5 5 5L20 6.5" />
		</svg>
	);
}

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API unavailable (permissions / non-secure context) — fall back.
		try {
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(area);
			return ok;
		} catch {
			return false;
		}
	}
}

/**
 * Terminal-style copyable command block. The whole block is a button: click
 * anywhere to copy. Shows a transient "copied" state.
 */
export function CopyCommand({
	command,
	label,
	className = "",
	nowrap = false,
}: {
	command: string;
	/** Accessible label, e.g. "brew install command". */
	label?: string;
	className?: string;
	/** Keep the command on one line at >=640px (hero / final CTA). */
	nowrap?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const onCopy = useCallback(async () => {
		const ok = await copyText(command);
		if (!ok) return;
		setCopied(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), 1800);
	}, [command]);

	return (
		<button
			type="button"
			onClick={onCopy}
			aria-label={copied ? "Copied to clipboard" : `Copy ${label ?? "command"}: ${command}`}
			title={copied ? "Copied" : "Click to copy"}
			className={`copy-command group ${nowrap ? "copy-command--nowrap" : ""} ${className}`}
		>
			<span className="copy-command-dollar" aria-hidden="true">
				$
			</span>
			<code className="copy-command-text">{command}</code>
			<span className="copy-command-action" aria-hidden="true">
				{copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
				<span className="copy-command-action-label">{copied ? "Copied" : "Copy"}</span>
			</span>
		</button>
	);
}
