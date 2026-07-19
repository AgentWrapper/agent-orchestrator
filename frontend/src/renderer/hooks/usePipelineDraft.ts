import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";
import { parseYamlToDraft, serializeToYaml, type PipelineDraft } from "../lib/pipeline-draft";
import type { PipelineValidationIssue } from "../lib/pipeline-yaml";

// The draft editor's state hook. It owns the YAML buffer (the canonical source
// in V1's YAML mode, so raw formatting and comments survive edits + save) and
// derives the PipelineDraft from it for the canvas/inspector (V2+). Canvas edits
// come back through setDraft, which reserializes. It debounce-calls the daemon's
// /validate endpoint and surfaces {valid, issues} for the problems UI (V6).

const VALIDATE_DEBOUNCE_MS = 400;

// Kept in the `pipeline`-prefixed query family (like usePipelineDefinitions) so
// the event-transport invalidation and cache conventions apply uniformly.
export const pipelineValidateQueryKey = (yamlSource: string) => ["pipeline-validate", yamlSource] as const;

export interface PipelineDraftValidation {
	// True while the buffer has changed but the authoritative answer for the
	// current text has not arrived yet (debounce pending or request in flight).
	isValidating: boolean;
	// null until the first result for a non-empty buffer arrives.
	valid: boolean | null;
	issues: PipelineValidationIssue[];
}

export interface UsePipelineDraftResult {
	yamlSource: string;
	setYamlSource: (next: string) => void;
	draft: PipelineDraft;
	parseError?: string;
	// General update helper for canvas/inspector edits: reserializes the draft
	// into the YAML buffer (V2+ callers). YAML-mode edits use setYamlSource.
	setDraft: (next: PipelineDraft) => void;
	validation: PipelineDraftValidation;
}

async function validateYaml(yamlSource: string): Promise<{ valid: boolean; issues: PipelineValidationIssue[] }> {
	const { data, error } = await apiClient.POST("/api/v1/pipelines/validate", { body: { yamlSource } });
	if (error) throw error;
	return { valid: data!.valid, issues: data!.issues };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(id);
	}, [value, delayMs]);
	return debounced;
}

export function usePipelineDraft(initialYaml: string): UsePipelineDraftResult {
	const [yamlSource, setYamlSourceState] = useState(initialYaml);
	// Canvas/inspector edits produce the next draft directly; hold it so those
	// edits render immediately while the debounced re-parse of the reserialized
	// buffer catches up. A YAML-pane edit clears it: the buffer is canonical.
	const [pending, setPending] = useState<PipelineDraft | null>(null);

	const debounced = useDebouncedValue(yamlSource, VALIDATE_DEBOUNCE_MS);
	// Parse on the debounced buffer, not per keystroke, so YAML typing stays
	// smooth (a parse rebuilds the whole canvas node set downstream).
	const parsed = useMemo(() => parseYamlToDraft(debounced), [debounced]);
	// On a YAML syntax error keep the last good graph (the split view must not
	// blank the canvas mid-edit); the error itself surfaces as parseError.
	const lastGoodRef = useRef(parsed.draft);
	if (!parsed.error) lastGoodRef.current = parsed.draft;

	const setYamlSource = useCallback((next: string) => {
		setPending(null);
		setYamlSourceState(next);
	}, []);
	const setDraft = useCallback((next: PipelineDraft) => {
		setPending(next);
		setYamlSourceState(serializeToYaml(next));
	}, []);

	const enabled = debounced.trim().length > 0;
	const query = useQuery({
		queryKey: pipelineValidateQueryKey(debounced),
		queryFn: () => validateYaml(debounced),
		enabled,
		staleTime: Infinity,
		retry: false,
	});

	// The answer is stale while the debounce still trails the live buffer or the
	// request is in flight — surface that so the indicator can show "checking".
	const isValidating = enabled && (debounced !== yamlSource || query.isFetching);
	const validation: PipelineDraftValidation = {
		isValidating,
		valid: query.data ? query.data.valid : null,
		issues: query.data?.issues ?? [],
	};

	const draft = pending ?? (parsed.error ? lastGoodRef.current : parsed.draft);
	// While a pending canvas edit awaits its round-trip re-parse, the buffer was
	// serialized by us and cannot be broken; suppress the stale error.
	const parseError = pending ? undefined : parsed.error;

	return { yamlSource, setYamlSource, draft, parseError, setDraft, validation };
}
