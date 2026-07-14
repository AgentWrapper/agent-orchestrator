import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { DashboardSubhead } from "./DashboardSubhead";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import {
	operatorAttentionQueryKey,
	useOperatorAttentionQuery,
	type OperatorAttentionItem,
} from "../hooks/useOperatorAttentionQuery";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { cn } from "../lib/utils";

// A decision item is answerable from the web only when the harness reported a
// genuine QUESTION. Permission-kind decisions stay display-only on purpose: the
// daemon refuses to answer them programmatically (SESSION_DECISION_NOT_ANSWERABLE)
// so an operator can never auto-approve a permission prompt from here — that
// asymmetry is deliberate (#305).
function isAnswerableQuestion(item: OperatorAttentionItem): item is OperatorAttentionItem & { sessionId: string } {
	return item.kind === "decision" && item.decisionKind === "question" && Boolean(item.sessionId);
}

const kindTone: Record<string, string> = {
	decision: "border-warning/40 bg-warning/10 text-warning",
	pr: "border-success/40 bg-success/10 text-success",
	worker_retry_exhausted: "border-destructive/40 bg-destructive/10 text-destructive",
	main_ci_red: "border-destructive/40 bg-destructive/10 text-destructive",
	duplicate_pr: "border-warning/40 bg-warning/10 text-warning",
	orchestrator_replacement_capped: "border-destructive/40 bg-destructive/10 text-destructive",
	orchestrator_dead: "border-destructive/40 bg-destructive/10 text-destructive",
	prime_dead: "border-destructive/40 bg-destructive/10 text-destructive",
};

const kindBadgeClassName =
	"h-auto min-h-5 w-auto min-w-0 max-w-full whitespace-normal break-words px-1.5 py-0.5 text-[10px] font-medium leading-3";

export function OperatorAttentionPage() {
	const navigate = useNavigate();
	const attention = useOperatorAttentionQuery();
	const items = attention.data ?? [];
	const showLoadError = attention.isError && items.length === 0;
	const [answeringId, setAnsweringId] = useState<string | null>(null);
	const toggleAnswer = (id: string) => setAnsweringId((cur) => (cur === id ? null : id));

	const openItem = (item: OperatorAttentionItem) => {
		if (isSafeExternalURL(item.prUrl)) {
			window.open(item.prUrl, "_blank", "noopener,noreferrer");
			return;
		}
		if (item.projectId && item.sessionId) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: item.projectId, sessionId: item.sessionId },
			});
			return;
		}
		if (isSafeExternalURL(item.deepLink)) {
			window.open(item.deepLink, "_blank", "noopener,noreferrer");
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Waiting on you"
				subtitle="Verify final gates and answer structured decisions from one place."
				count={items.length}
			/>

			<div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
				{showLoadError ? (
					<p className="py-10 text-center text-[12px] text-passive">Could not load waiting items.</p>
				) : items.length === 0 ? (
					<p className="py-10 text-center text-[12px] text-passive">Nothing is waiting on you.</p>
				) : (
					<>
						<div className="space-y-2 md:hidden">
							{items.map((item) => (
								<AttentionCard
									key={item.id}
									item={item}
									onOpen={() => openItem(item)}
									answerable={isAnswerableQuestion(item)}
									answering={answeringId === item.id}
									onToggleAnswer={() => toggleAnswer(item.id)}
									onAnswered={() => setAnsweringId(null)}
								/>
							))}
						</div>
						<Table className="hidden md:table">
							<TableHeader>
								<TableRow>
									<TableHead className="w-56">Kind</TableHead>
									<TableHead>Item</TableHead>
									<TableHead>Reason</TableHead>
									<TableHead className="w-48 text-right">Action</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((item) => (
									<AttentionRow
										key={item.id}
										item={item}
										onOpen={() => openItem(item)}
										answerable={isAnswerableQuestion(item)}
										answering={answeringId === item.id}
										onToggleAnswer={() => toggleAnswer(item.id)}
										onAnswered={() => setAnsweringId(null)}
									/>
								))}
							</TableBody>
						</Table>
					</>
				)}
			</div>
		</div>
	);
}

function hasOpenTarget(item: OperatorAttentionItem) {
	return Boolean(
		isSafeExternalURL(item.prUrl) || (item.projectId && item.sessionId) || isSafeExternalURL(item.deepLink),
	);
}

function isSafeExternalURL(value?: string) {
	return typeof value === "string" && value.startsWith("https://");
}

function itemTitle(item: OperatorAttentionItem) {
	return item.kind === "pr"
		? `${item.prNumber ? `#${item.prNumber} ` : ""}${item.prTitle || "Pull request"}`
		: item.sessionTitle || item.sessionId || "Session";
}

function itemMeta(item: OperatorAttentionItem) {
	return [item.projectId, item.sessionId, item.decisionKind || ""].filter(Boolean).join(" · ");
}

type AttentionEntryProps = {
	item: OperatorAttentionItem;
	onOpen: () => void;
	answerable: boolean;
	answering: boolean;
	onToggleAnswer: () => void;
	onAnswered: () => void;
};

function AttentionCard({ item, onOpen, answerable, answering, onToggleAnswer, onAnswered }: AttentionEntryProps) {
	const canOpen = hasOpenTarget(item);
	return (
		<div>
			<button
				className={cn(
					"w-full rounded-md border border-border bg-surface p-3 text-left transition-colors",
					canOpen ? "hover:border-border-strong" : "cursor-default",
				)}
				disabled={!canOpen}
				onClick={onOpen}
				type="button"
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="truncate text-[13px] font-medium text-foreground">{itemTitle(item)}</div>
						<div className="mt-0.5 truncate font-mono text-[10px] text-passive">{itemMeta(item)}</div>
					</div>
					<Badge variant="outline" className={cn(kindBadgeClassName, "shrink-0", kindTone[item.kind])}>
						{item.kind}
					</Badge>
				</div>
				<p className="mt-2 text-[12px] leading-5 text-muted-foreground">{item.reason}</p>
				<div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-foreground">
					{item.prUrl ? <ExternalLink className="size-3 shrink-0" aria-hidden="true" /> : null}
					<span className="min-w-0 truncate">{item.action}</span>
				</div>
			</button>
			{answerable ? (
				<div className="mt-2 rounded-md border border-border bg-surface/40 p-2">
					<div className="flex items-center justify-between gap-2">
						<span className="text-[11px] font-medium text-foreground">Answer this question</span>
						<Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={onToggleAnswer} type="button">
							{answering ? "Cancel" : "Answer"}
						</Button>
					</div>
					{answering && item.sessionId ? (
						<div className="mt-2">
							<DecisionAnswerPanel sessionId={item.sessionId} decisionKey={item.updatedAt} onAnswered={onAnswered} />
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function AttentionRow({ item, onOpen, answerable, answering, onToggleAnswer, onAnswered }: AttentionEntryProps) {
	const title = itemTitle(item);
	const meta = itemMeta(item);
	const canOpen = hasOpenTarget(item);

	return (
		<>
			<TableRow className={cn(canOpen && "cursor-pointer")} onClick={canOpen ? onOpen : undefined}>
				<TableCell>
					<Badge variant="outline" className={cn(kindBadgeClassName, kindTone[item.kind])}>
						{item.kind}
					</Badge>
				</TableCell>
				<TableCell className="max-w-0">
					<div className="truncate text-[13px] text-foreground">{title}</div>
					<div className="truncate font-mono text-[10px] text-passive">{meta}</div>
					{item.question ? (
						<div className="mt-1 truncate text-[11px] text-muted-foreground">{item.question}</div>
					) : null}
				</TableCell>
				<TableCell className="max-w-[360px] text-[12px] text-muted-foreground">{item.reason}</TableCell>
				<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
					<div className="flex items-center justify-end gap-1.5">
						{answerable ? (
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-[11px]"
								onClick={onToggleAnswer}
								title={answering ? "Cancel" : "Answer question"}
								type="button"
							>
								{answering ? "Cancel" : "Answer"}
							</Button>
						) : null}
						<Button
							size="sm"
							variant="ghost"
							className="h-6 max-w-[180px] justify-end px-2 text-[11px]"
							disabled={!canOpen}
							onClick={onOpen}
							title={item.action}
							type="button"
						>
							{item.prUrl ? <ExternalLink className="size-3" aria-hidden="true" /> : null}
							<span className="truncate">{item.action}</span>
						</Button>
					</div>
				</TableCell>
			</TableRow>
			{answerable && answering && item.sessionId ? (
				<TableRow>
					<TableCell colSpan={4} className="bg-surface/40">
						<DecisionAnswerPanel sessionId={item.sessionId} decisionKey={item.updatedAt} onAnswered={onAnswered} />
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}

// DecisionAnswerPanel fetches the live decision for a session (to get the option
// labels the attention item does not carry), then answers it via
// POST /sessions/{id}/decision. The daemon still owns the answerability rule:
// a permission decision returns SESSION_DECISION_NOT_ANSWERABLE (409), which is
// surfaced here rather than swallowed.
//
// Two staleness contracts:
//   - The fetched decision is keyed by the attention item's identity
//     (decisionKey = the item's updatedAt) and the cache entry is dropped after a
//     successful answer, so a follow-up question can never reuse the previous
//     question's options and submit a stale numeric index against it.
//   - The controls render only when the LIVE fetched decision has
//     kind === "question". A stale question item whose live decision has since
//     become a permission prompt stays display-only — same contract as the
//     permission items on the page.
function DecisionAnswerPanel({
	sessionId,
	decisionKey,
	onAnswered,
}: {
	sessionId: string;
	decisionKey: string;
	onAnswered: () => void;
}) {
	const queryClient = useQueryClient();
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);

	const decisionQueryKey = ["session-decision", sessionId, decisionKey] as const;
	const decisionQuery = useQuery({
		queryKey: decisionQueryKey,
		queryFn: async () => {
			const { data, error: apiError } = await apiClient.GET("/api/v1/sessions/{sessionId}/decision", {
				params: { path: { sessionId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
			return data;
		},
		retry: false,
	});

	const answer = useMutation({
		mutationFn: async (body: { option?: number; text?: string; revision: string }) => {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/decision", {
				params: { path: { sessionId } },
				body,
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: async () => {
			setError(null);
			// Drop the fetched decision outright: it has been consumed, and a
			// follow-up question for the same session must be fetched fresh, never
			// answered through this one's cached options.
			queryClient.removeQueries({ queryKey: decisionQueryKey });
			await queryClient.invalidateQueries({ queryKey: operatorAttentionQueryKey });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onAnswered();
		},
		onError: (e) => setError(e instanceof Error ? e.message : "Answer failed"),
	});

	const decision = decisionQuery.data;
	// Answering requires the dialog's revision: the daemon compare-and-swaps the
	// answer against it, so a dialog replaced after this fetch is rejected as
	// stale instead of receiving an option index meant for the old one.
	const revision = decision?.revision;
	const isLiveQuestion = decision?.kind === "question" && Boolean(revision);
	const options = isLiveQuestion ? (decision?.options ?? []) : [];
	const question = decision?.question;
	// Controls stay disabled until the CURRENT fetch has settled, so an answer can
	// never be submitted against options the page has not confirmed are current.
	const busy = answer.isPending || decisionQuery.isFetching;

	return (
		<div className="flex flex-col gap-2">
			{question ? <div className="text-[12px] text-foreground">{question}</div> : null}
			{decisionQuery.isError ? (
				<div className="text-[11px] text-destructive">{apiErrorMessage(decisionQuery.error)}</div>
			) : null}
			{decision && decision.kind !== "question" ? (
				<div className="text-[11px] text-muted-foreground">
					This session is now blocked on a permission prompt, which cannot be answered from here — attend in the
					terminal.
				</div>
			) : null}
			{decision && decision.kind === "question" && !revision ? (
				// A question without a revision predates the answer-identity contract
				// (daemon not yet redeployed, or a dialog recorded by an older daemon).
				// It cannot be answered safely from here.
				<div className="text-[11px] text-muted-foreground">
					This dialog cannot be answered from here right now — attend in the terminal.
				</div>
			) : null}
			{options.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{options.map((label, index) => (
						<Button
							key={`${label}-${index}`}
							size="sm"
							variant="outline"
							className="h-6 px-2 text-[11px]"
							disabled={busy}
							onClick={() => revision && answer.mutate({ option: index + 1, revision })}
							type="button"
						>
							{`${index + 1}. ${label}`}
						</Button>
					))}
				</div>
			) : null}
			{isLiveQuestion ? (
				<form
					className="flex items-center gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						const trimmed = text.trim();
						if (!trimmed || busy || !revision) return;
						answer.mutate({ text: trimmed, revision });
					}}
				>
					<input
						aria-label="Free-text answer"
						className="h-6 flex-1 rounded border border-border bg-background px-2 text-[11px] text-foreground outline-none focus:border-border-strong"
						placeholder="Type an answer…"
						value={text}
						onChange={(e) => setText(e.target.value)}
						disabled={busy}
					/>
					<Button
						size="sm"
						variant="primary"
						className="h-6 px-2 text-[11px]"
						disabled={busy || !text.trim()}
						type="submit"
					>
						{busy ? "Sending…" : "Send"}
					</Button>
				</form>
			) : null}
			{error ? <div className="text-[11px] text-destructive">{error}</div> : null}
		</div>
	);
}
