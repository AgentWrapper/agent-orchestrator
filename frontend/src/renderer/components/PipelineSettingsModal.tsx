import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
	ALL_CONCURRENCY_SCOPES,
	ALL_PR_EVENTS,
	ALL_SESSION_EVENTS,
	type ConcurrencyScope,
	DEFAULT_STAGE_DEADLINE,
	type PipelineDraft,
	type PREvent,
	type SessionEvent,
} from "../lib/pipeline-draft";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

// PipelineSettingsModal edits the pipeline-level draft fields (mockup 1b top):
// name, the `on:` triggers, the concurrency block, and the defaults block.
// Edits stay local until Done, which hands the caller the updated draft to
// commit through usePipelineDraft's setDraft; Cancel (or dismissing) discards
// them.
//
// The concurrency block carries the spec §10 guidance inline, because both of
// its decisions are ones a user gets exactly one shot at: an unset scope
// resolves from the subject (invisible unless the modal says so), and
// cancel-in-progress is right for a `pr.updated` review pipeline and actively
// destructive on a release. So the copy is derived from the draft rather than
// static: it names what the default resolves to given the declared triggers,
// and it warns when the current setting contradicts the pipeline's shape.

export interface PipelineSettingsModalProps {
	open: boolean;
	value: PipelineDraft;
	onCancel: () => void;
	onDone: (value: PipelineDraft) => void;
}

// scopeHint states the effective bucket. With no explicit scope the engine
// resolves it per run from the subject (Subject.DefaultScope: pr -> pr,
// session -> session, anything else -> project), so the hint enumerates what
// the declared triggers can produce instead of naming one scope.
function scopeHint(scope: ConcurrencyScope | undefined, hasPR: boolean, hasSession: boolean): string {
	switch (scope) {
		case "pr":
			return "One bucket per PR number, so two different PRs never collide.";
		case "session":
			return "One bucket per session.";
		case "project":
			return "One bucket for the whole project. Every run in this group serializes, whichever PR or session triggered it.";
		default:
			if (hasPR && hasSession) {
				return "Subject default: a pr event serializes per PR number, a session event per session.";
			}
			if (hasPR) return "Subject default: a pr event serializes per PR number, so two different PRs never collide.";
			if (hasSession) return "Subject default: a session event serializes per session.";
			return "Subject default: a hand-started run serializes per project.";
	}
}

export function PipelineSettingsModal({ open, value, onCancel, onDone }: PipelineSettingsModalProps) {
	const [draft, setDraft] = useState<PipelineDraft>(value);

	// Reseed the local draft each time the modal opens; edits while open stay
	// local until Done.
	useEffect(() => {
		if (open) setDraft(value);
	}, [open, value]);

	const stageIds = draft.stages.map((s) => s.id).filter(Boolean);

	// An empty `on`/`concurrency`/`defaults` block round-trips as absent rather
	// than as an empty mapping, matching the codec's pruning.
	const patchBlock = <K extends "on" | "concurrency" | "defaults">(key: K, patch: Partial<PipelineDraft[K]>) => {
		const merged = { ...draft[key], ...patch } as Record<string, unknown>;
		for (const [k, v] of Object.entries(merged)) {
			if (v === undefined || (Array.isArray(v) && v.length === 0)) delete merged[k];
		}
		const next = { ...draft };
		if (Object.keys(merged).length > 0) next[key] = merged as PipelineDraft[K];
		else delete next[key];
		setDraft(next);
	};

	const togglePREvent = (event: PREvent) => {
		const on = draft.on?.pr ?? [];
		patchBlock("on", { pr: on.includes(event) ? on.filter((e) => e !== event) : [...on, event] });
	};

	const toggleSessionEvent = (event: SessionEvent) => {
		const on = draft.on?.session ?? [];
		patchBlock("on", { session: on.includes(event) ? on.filter((e) => e !== event) : [...on, event] });
	};

	const prEvents = draft.on?.pr ?? [];
	const sessionEvents = draft.on?.session ?? [];
	const scope = draft.concurrency?.scope;
	const cancelInProgress = draft.concurrency?.cancelInProgress ?? false;

	// The §11 forcing function: `pr.merged` defaults to per-PR scope, which lets
	// two merges release concurrently. Only worth saying when the effective scope
	// really is `pr`.
	const mergedUnderPRScope =
		prEvents.includes("merged") && (scope === "pr" || (scope === undefined && prEvents.length > 0));

	// Release shaped means "an in-flight run must be allowed to finish": either
	// the author already said `scope: project` (the thing being protected is
	// project-wide), or the trigger is a merge and nothing that re-fires on a
	// push. A pipeline declaring both `merged` and `updated` is review shaped,
	// because the push case is the one that recurs.
	const releaseShaped = scope === "project" || (prEvents.includes("merged") && !prEvents.includes("updated"));
	const reviewShaped = !releaseShaped && prEvents.includes("updated");

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent showCloseButton={false} aria-describedby={undefined} className="max-w-3xl">
				<DialogHeader className="flex-row items-center justify-between">
					<div className="min-w-0">
						<DialogTitle>Pipeline settings</DialogTitle>
						<p className="mt-0.5 truncate text-caption text-passive">
							{draft.name || "untitled"} · triggers, concurrency, and stage defaults
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button size="sm" onClick={() => onDone(draft)}>
							Done
						</Button>
					</div>
				</DialogHeader>

				<div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
					<label className="flex flex-col gap-1.5">
						<FieldLabel>Name</FieldLabel>
						<Input
							aria-label="Pipeline name"
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
					</label>

					<Section label="Triggers">
						<p className="mb-2 text-caption text-passive">
							A trigger names the subject a run works on, which decides its workspace and its default concurrency scope.
						</p>
						<div className="flex flex-col gap-2">
							<EventRow
								caption="on.pr"
								events={ALL_PR_EVENTS}
								active={prEvents}
								onToggle={(e) => togglePREvent(e as PREvent)}
							/>
							<EventRow
								caption="on.session"
								events={ALL_SESSION_EVENTS}
								active={sessionEvents}
								onToggle={(e) => toggleSessionEvent(e as SessionEvent)}
							/>
						</div>
						{prEvents.length === 0 && sessionEvents.length === 0 && (
							<Hint>No triggers: the pipeline runs only when started by hand.</Hint>
						)}
					</Section>

					<Section label="Concurrency">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<SubLabel>Scope</SubLabel>
								<Select
									value={scope ?? "__subject"}
									onValueChange={(next) =>
										patchBlock("concurrency", {
											scope: next === "__subject" ? undefined : (next as ConcurrencyScope),
										})
									}
								>
									<SelectTrigger size="sm" aria-label="Concurrency scope" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__subject">Subject default</SelectItem>
										{ALL_CONCURRENCY_SCOPES.map((s) => (
											<SelectItem key={s} value={s}>
												{s}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Hint>{scopeHint(scope, prEvents.length > 0, sessionEvents.length > 0)}</Hint>
							</div>

							<label className="flex flex-col gap-1.5">
								<SubLabel>Group</SubLabel>
								<Input
									aria-label="Concurrency group"
									value={draft.concurrency?.group ?? ""}
									onChange={(e) => patchBlock("concurrency", { group: e.target.value || undefined })}
									placeholder={draft.name || "(pipeline name)"}
								/>
								<Hint>
									Defaults to the pipeline name. Runs sharing a scope identity and a group serialize, so two pipelines
									with the same group share one bucket.
								</Hint>
							</label>
						</div>

						{mergedUnderPRScope && (
							<Warning>
								<code className="font-mono">on.pr: merged</code> under per-PR scope lets two merges publish at the same
								time. A release pipeline wants <code className="font-mono">scope: project</code>, because what needs
								serializing is the project, not the PR.
							</Warning>
						)}

						<div className="mt-3 flex flex-col gap-1.5">
							<div className="flex items-center justify-between gap-3">
								<SubLabel>Cancel in progress</SubLabel>
								<div className="flex items-center gap-2">
									<span className="text-caption text-muted-foreground">{cancelInProgress ? "On" : "Off"}</span>
									<Switch
										aria-label="Cancel in progress"
										checked={cancelInProgress}
										onCheckedChange={(checked) => patchBlock("concurrency", { cancelInProgress: checked })}
									/>
								</div>
							</div>
							<Hint>
								On, a new run cancels the one in flight. Off, it queues behind, and queue depth is 1, so a third arrival
								evicts the queued run.
							</Hint>
							{reviewShaped &&
								(cancelInProgress ? (
									<Hint>Recommended for pr.updated: the new push cancels the review of the old head.</Hint>
								) : (
									<Warning>
										<code className="font-mono">on.pr: updated</code> is declared and this is off, so a push leaves the
										in-flight run reviewing a commit nobody is looking at. Review pipelines want it on.
									</Warning>
								))}
							{releaseShaped &&
								(cancelInProgress ? (
									<Warning>
										This pipeline is release shaped ({scope === "project" ? "scope: project" : "on.pr: merged"}).
										Cancelling mid-publish or mid-notarization leaves a partial release with no rollback, so release
										pipelines want this off.
									</Warning>
								) : (
									<Hint>
										Recommended for release pipelines: an in-flight release finishes even when the next one arrives.
									</Hint>
								))}
						</div>
					</Section>

					<Section label="Stage defaults">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<label className="flex flex-col gap-1.5">
								<SubLabel>Deadline</SubLabel>
								<Input
									aria-label="Default deadline"
									value={draft.defaults?.deadline ?? ""}
									onChange={(e) => patchBlock("defaults", { deadline: e.target.value || undefined })}
									placeholder={DEFAULT_STAGE_DEADLINE}
								/>
								<Hint>
									Applies to every stage that names none. Empty means the engine default, {DEFAULT_STAGE_DEADLINE}.
								</Hint>
							</label>

							<div className="flex flex-col gap-1.5">
								<SubLabel>On failure</SubLabel>
								<Select
									value={draft.defaults?.onFailure ?? "__none"}
									onValueChange={(id) => patchBlock("defaults", { onFailure: id === "__none" ? undefined : id })}
								>
									<SelectTrigger size="sm" aria-label="Default on failure" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none">None</SelectItem>
										{stageIds.map((id) => (
											<SelectItem key={id} value={id}>
												{id}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Hint>
									Every stage that names no failure route lands here. Without it, a failed branch ends in silence.
								</Hint>
							</div>
						</div>
					</Section>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function EventRow({
	caption,
	events,
	active,
	onToggle,
}: {
	caption: string;
	events: readonly string[];
	active: readonly string[];
	onToggle: (event: string) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<span className="w-24 shrink-0 font-mono text-micro text-passive">{caption}</span>
			{events.map((event) => {
				const on = active.includes(event);
				return (
					<button
						key={event}
						type="button"
						aria-pressed={on}
						onClick={() => onToggle(event)}
						className={cn(
							"rounded-md border px-2 py-0.5 font-mono text-caption transition-colors",
							on
								? "border-accent-dim bg-accent-weak text-accent"
								: "border-border bg-raised text-muted-foreground hover:text-foreground",
						)}
					>
						{event}
					</button>
				);
			})}
		</div>
	);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section>
			<h3 className="mb-1.5 font-mono text-micro font-medium uppercase tracking-wide text-passive">{label}</h3>
			{children}
		</section>
	);
}

function SubLabel({ children }: { children: React.ReactNode }) {
	return <span className="text-caption text-muted-foreground">{children}</span>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-micro font-medium uppercase tracking-wide text-passive">{children}</span>;
}

function Hint({ children }: { children: React.ReactNode }) {
	return <p className="text-caption text-passive">{children}</p>;
}

function Warning({ children }: { children: React.ReactNode }) {
	return (
		<p className="mt-1.5 flex items-start gap-1.5 text-caption text-warning">
			<AlertTriangle className="mt-0.5 size-icon-xs shrink-0" aria-hidden="true" />
			<span>{children}</span>
		</p>
	);
}
