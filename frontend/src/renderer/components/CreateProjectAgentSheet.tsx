import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { AGENT_OPTIONS } from "../lib/agent-options";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type CreateProjectAgentSelection = {
	workerAgent: string;
	orchestratorAgent: string;
};

type CreateProjectAgentSheetProps = {
	error?: string | null;
	isCreating: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (selection: CreateProjectAgentSelection) => Promise<void>;
	open: boolean;
	path: string | null;
};

export function CreateProjectAgentSheet({
	error,
	isCreating,
	onOpenChange,
	onSubmit,
	open,
	path,
}: CreateProjectAgentSheetProps) {
	const [workerAgent, setWorkerAgent] = useState("");
	const [orchestratorAgent, setOrchestratorAgent] = useState("");
	const canSubmit = workerAgent !== "" && orchestratorAgent !== "" && !isCreating;

	useEffect(() => {
		if (!open) {
			setWorkerAgent("");
			setOrchestratorAgent("");
		}
	}, [open, path]);

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !isCreating && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
						<div className="min-w-0">
							<Dialog.Title className="text-[15px] font-semibold text-foreground">Project agents</Dialog.Title>
							<Dialog.Description className="mt-1 break-all text-[12px] text-muted-foreground">
								{path ?? ""}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close project agents dialog"
								disabled={isCreating}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<form
						className="space-y-4 px-5 py-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canSubmit) return;
							void onSubmit({ workerAgent, orchestratorAgent });
						}}
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<RequiredAgentField
								id="newProjectWorkerAgent"
								label="Worker agent"
								placeholder="Select worker agent"
								value={workerAgent}
								onChange={setWorkerAgent}
							/>
							<RequiredAgentField
								id="newProjectOrchestratorAgent"
								label="Orchestrator agent"
								placeholder="Select orchestrator agent"
								value={orchestratorAgent}
								onChange={setOrchestratorAgent}
							/>
						</div>

						{error && (
							<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
								{error}
							</div>
						)}

						<div className="flex items-center justify-end gap-2 pt-1">
							<Button type="button" variant="ghost" disabled={isCreating} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" disabled={!canSubmit}>
								{isCreating ? "Creating..." : "Create and start"}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export const RequiredAgentField = memo(function RequiredAgentField({
	id,
	invalid = false,
	label,
	onChange,
	placeholder,
	value,
}: {
	id: string;
	invalid?: boolean;
	label: string;
	onChange: (value: string) => void;
	placeholder: string;
	value: string;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-[12px] font-medium text-muted-foreground">
				{label}
			</Label>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger id={id} className="h-8 w-full text-[13px]" aria-invalid={invalid || undefined}>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent>
					{AGENT_OPTIONS.map((agent) => (
						<SelectItem key={agent} value={agent}>
							{agent}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
});
