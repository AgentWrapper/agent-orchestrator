import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { importSharedSession, sharedBoardId, SHARED_PROJECT_ID } from "../lib/cloud-sessions";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { Button } from "./ui/button";

// Viewer-side import (model A). Paste a teammate's share link/code → the session
// shows up on the board under "Shared with me", read-only, streaming live, and we
// navigate straight to it so the import is visibly confirmed.
export function ImportSharedSessionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setToken("");
			setError(null);
		}
	}, [open]);

	const submit = () => {
		setError(null);
		try {
			const payload = importSharedSession(token);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onOpenChange(false);
			// Jump to the imported session so the user lands on it (not left on
			// whatever they were viewing).
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: SHARED_PROJECT_ID, sessionId: sharedBoardId(payload.sandboxId) },
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not import this share link.");
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-xl">
					<div className="flex items-start justify-between gap-3">
						<div>
							<Dialog.Title className="text-sm font-semibold text-foreground">Open shared session</Dialog.Title>
							<Dialog.Description className="mt-1 text-xs leading-relaxed text-passive">
								Paste the link (or code) a teammate shared with you. The session appears under{" "}
								<span className="font-medium text-foreground">Shared with me</span>, read-only.
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button type="button" aria-label="Close" className="text-passive hover:text-foreground">
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="mt-4 flex flex-col gap-3">
						<textarea
							autoFocus
							value={token}
							onChange={(e) => setToken(e.target.value)}
							placeholder="Paste share link…"
							aria-label="Share link"
							className="h-24 w-full resize-none rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs leading-normal text-foreground outline-none focus-visible:ring-1 focus-visible:ring-accent"
						/>
						{error ? (
							<p role="alert" className="text-xs leading-relaxed text-error">
								{error}
							</p>
						) : null}
						<div className="flex items-center justify-end gap-2">
							<Dialog.Close asChild>
								<Button type="button" variant="ghost">
									Cancel
								</Button>
							</Dialog.Close>
							<Button type="button" disabled={token.trim().length === 0} onClick={submit}>
								Open session
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
