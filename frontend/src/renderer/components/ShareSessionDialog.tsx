import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { sandboxIdFromBoardId } from "../lib/cloud-sessions";
import type { WorkspaceSession } from "../types/workspace";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// Owner-side share modal (model A, client-side readonly). Mints a readonly token
// for a cloud session (via the Go daemon) and hands the owner a clickable
// ao://share/<token> link to send a teammate.
export function ShareSessionDialog({
	session,
	open,
	onOpenChange,
}: {
	session: WorkspaceSession;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [token, setToken] = useState<string | null>(null);
	const [ttlSec, setTtlSec] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!open) {
			setToken(null);
			setError(null);
			setCopied(false);
			return;
		}
		const sandboxId = sandboxIdFromBoardId(session.id);
		if (!sandboxId) {
			setError("This session can't be shared (not a cloud session).");
			return;
		}
		let cancelled = false;
		void apiClient
			.POST("/api/v1/cloud/sessions/{sandboxId}/share", {
				params: { path: { sandboxId } },
				body: { projectName: session.workspaceName },
			})
			.then(({ data, error: apiError }) => {
				if (cancelled) return;
				if (apiError || !data?.token) {
					setError(apiErrorMessage(apiError, "Could not mint a share link — the sandbox may be gone."));
					return;
				}
				setToken(data.token);
				setTtlSec(data.expiresInSec);
			});
		return () => {
			cancelled = true;
		};
	}, [open, session.id, session.workspaceName]);

	const link = token ? `ao://share/${token}` : null;
	const ttlHours = ttlSec ? Math.round(ttlSec / 3600) : null;

	const copy = async () => {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* clipboard blocked; the user can still select the text */
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-xl">
					<div className="flex items-start justify-between gap-3">
						<div>
							<Dialog.Title className="text-sm font-semibold text-foreground">Share session</Dialog.Title>
							<Dialog.Description className="mt-1 text-xs leading-relaxed text-passive">
								Send this link to a teammate. Clicking it opens their AO and loads{" "}
								<span className="font-medium text-foreground">{session.title}</span> live — read-only. (No AO yet? They can paste it into{" "}
								<span className="font-medium text-foreground">Open shared session</span>.)
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button type="button" aria-label="Close" className="text-passive hover:text-foreground">
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="mt-4">
						{error ? (
							<p role="alert" className="text-xs leading-relaxed text-error">
								{error}
							</p>
						) : link ? (
							<div className="flex flex-col gap-2">
								<div className="flex items-start gap-2">
									<textarea
										readOnly
										value={link}
										aria-label="Share link"
										onFocus={(e) => e.currentTarget.select()}
										className="h-20 flex-1 resize-none rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs leading-normal text-foreground"
									/>
									<Button type="button" size="sm" variant="outline" onClick={() => void copy()} aria-label="Copy share link">
										{copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
										{copied ? "Copied" : "Copy"}
									</Button>
								</div>
								<p className={cn("text-2xs leading-normal text-passive")}>
									Read-only for now, and the link works for about {ttlHours ?? 24}h. Anyone with the link can view the session, so share it
									carefully — revocable, scoped access is coming next.
								</p>
							</div>
						) : (
							<p className="text-xs text-passive">Minting share link…</p>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
