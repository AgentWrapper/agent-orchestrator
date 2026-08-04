import { AlertTriangle, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { prerequisitesQueryKey, usePrerequisites } from "../hooks/usePrerequisites";
import { TopbarButton } from "./TopbarButton";

// PrerequisiteBanner surfaces a missing session runtime on the board, where the
// user will act on it, instead of leaving it to fail at spawn time inside the
// daemon. It never blocks: the rest of the app works without tmux, only spawning
// does not.
//
// The Install button appears only when the daemon says it can run the command
// without a password prompt (Homebrew on macOS). Elsewhere the command is shown
// to copy and run, because the app has no terminal to answer `sudo` on.
export function PrerequisiteBanner() {
	const { t } = useTranslation();
	const query = usePrerequisites();
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const tmux = query.data?.tmux;
	if (!tmux || tmux.satisfied) return null;

	const install = async () => {
		setBusy(true);
		setError(undefined);
		const { error: apiErr } = await apiClient.POST("/api/v1/prerequisites/tmux/install");
		if (apiErr) setError(apiErrorMessage(apiErr, t("prereq.installFailed")));
		await queryClient.invalidateQueries({ queryKey: prerequisitesQueryKey });
		setBusy(false);
	};

	const copy = async () => {
		if (!tmux.installCommand) return;
		await aoBridge.clipboard.writeText(tmux.installCommand);
		setCopied(true);
	};

	return (
		<div
			className="mx-3 my-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground"
			data-testid="prerequisite-banner"
			role="status"
		>
			<AlertTriangle className="size-icon-base shrink-0 text-warning" aria-hidden="true" />
			<span className="min-w-0 flex-1">
				{error ?? t("prereq.tmux.body")}
				{tmux.installCommand ? <code className="ml-2 rounded bg-background px-1.5 py-0.5">{tmux.installCommand}</code> : null}
			</span>
			{tmux.installable ? (
				<TopbarButton disabled={busy} onClick={() => void install()} variant="primary">
					{busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
					{busy ? t("prereq.installing") : t("prereq.install")}
				</TopbarButton>
			) : null}
			{tmux.installCommand && !tmux.installable ? (
				<TopbarButton onClick={() => void copy()}>{copied ? t("prereq.copied") : t("prereq.copyCommand")}</TopbarButton>
			) : null}
			<TopbarButton disabled={query.isFetching} onClick={() => void query.refetch()}>
				{t("prereq.recheck")}
			</TopbarButton>
		</div>
	);
}
