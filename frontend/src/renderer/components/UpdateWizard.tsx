import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "./ui/button";
import { aoBridge, isTauri } from "../lib/bridge";
import { isProdBuild } from "../lib/build-env";
import { updateSettingsQueryKey } from "./settings/UpdatesSection";
import type { UpdateSettings } from "../../shared/bridge-types";

// UpdateWizard is the Tauri in-app equivalent of auto-updater.ts's
// `ensureUpdatePrefs` (frontend/src/main/auto-updater.ts:562-605), which used
// three native `dialog.showMessageBox` prompts on first packaged launch.
// Under Tauri there is no main-process dialog surface with the same one-shot
// semantics, so this is a renderer modal wizard with the same copy and the
// same three steps:
//   1. Opt in to automatic updates, or not.
//   2. Choose a channel: Stable or Nightly.
//   3. If Nightly: acknowledge the instability disclaimer (or fall back to Stable).
//
// Gated on `updateSettings.hasDecision()` (Tauri-only bridge method) so it
// only shows once, before `update-settings.json` exists on disk — exactly
// like the Electron `existsSync` guard.
type Step = "optIn" | "channel" | "nightlyAck";

export function UpdateWizard() {
	const queryClient = useQueryClient();
	const [dismissed, setDismissed] = useState(false);
	const [step, setStep] = useState<Step>("optIn");

	const hasDecisionQuery = useQuery({
		queryKey: ["update-settings-has-decision"],
		queryFn: () => aoBridge.updateSettings.hasDecision?.() ?? Promise.resolve(true),
		enabled: isTauri,
	});

	// Auto-updates (and this one-shot opt-in wizard) only apply to packaged
	// builds, matching the Rust side's `!cfg!(debug_assertions)` gate on the
	// hourly check timer and escalation loop.
	const open =
		isTauri && isProdBuild() && hasDecisionQuery.isSuccess && hasDecisionQuery.data === false && !dismissed;
	if (!open) return null;

	const finish = async (settings: UpdateSettings) => {
		await aoBridge.updateSettings.set(settings);
		await queryClient.invalidateQueries({ queryKey: updateSettingsQueryKey });
		await queryClient.invalidateQueries({ queryKey: ["update-settings-has-decision"] });
		setDismissed(true);
	};

	return (
		<Dialog.Root
			open
			onOpenChange={(next) => {
				if (!next) void finish({ enabled: false, channel: "latest", nightlyAck: false, feature: null });
			}}
		>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-overlay bg-scrim" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-dialog-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 shadow-lg">
					{step === "optIn" && (
						<>
							<Dialog.Title className="text-sm font-medium text-foreground">
								Keep Agent Orchestrator up to date automatically?
							</Dialog.Title>
							<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
								You can change this later in Settings.
							</Dialog.Description>
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="ghost"
									onClick={() => void finish({ enabled: false, channel: "latest", nightlyAck: false, feature: null })}
								>
									Not now
								</Button>
								<Button type="button" variant="primary" onClick={() => setStep("channel")}>
									Enable auto-updates
								</Button>
							</div>
						</>
					)}

					{step === "channel" && (
						<>
							<Dialog.Title className="text-sm font-medium text-foreground">Which update channel?</Dialog.Title>
							<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
								Stable is released and tested. Nightly is the newest daily build.
							</Dialog.Description>
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => void finish({ enabled: true, channel: "latest", nightlyAck: false, feature: null })}
								>
									Stable
								</Button>
								<Button type="button" variant="primary" onClick={() => setStep("nightlyAck")}>
									Nightly
								</Button>
							</div>
						</>
					)}

					{step === "nightlyAck" && (
						<>
							<Dialog.Title className="text-sm font-medium text-foreground">
								Nightly builds can be unstable
							</Dialog.Title>
							<Dialog.Description className="mt-2 text-control leading-body text-muted-foreground">
								Nightly is built every day and may be broken or lose data. Only use it if you are comfortable with that.
							</Dialog.Description>
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => void finish({ enabled: true, channel: "latest", nightlyAck: false, feature: null })}
								>
									Use Stable instead
								</Button>
								<Button
									type="button"
									variant="primary"
									onClick={() => void finish({ enabled: true, channel: "nightly", nightlyAck: true, feature: null })}
								>
									I understand, use Nightly
								</Button>
							</div>
						</>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
