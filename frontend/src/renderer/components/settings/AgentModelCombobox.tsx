import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentModelCatalog } from "../../hooks/useAgentModelsQuery";
import { cn } from "../../lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const MAX_VISIBLE_MODELS = 50;

type AgentModel = NonNullable<AgentModelCatalog["models"]>[number];

type IndexedModel = {
	model: AgentModel;
	id: string;
	label: string;
	provider: string;
	normalizedID: string;
	normalizedLabel: string;
	normalizedProvider: string;
	index: number;
};

type ModelSearchIndex = {
	models: IndexedModel[];
	byID: Map<string, IndexedModel>;
	providerBuckets: Map<string, { models: IndexedModel[]; indexes: Set<number> }>;
	trigramPostings: Map<string, Set<number>>;
};

export type ModelSearchResult = {
	models: IndexedModel[];
	candidateCount: number;
	strategy: "direct" | "provider-index" | "text-index" | "fuzzy-fallback";
};

export function AgentModelCombobox({
	value,
	models,
	allowCustom,
	onChange,
	onCustom,
	triggerLabel,
	triggerClassName,
	"aria-label": ariaLabel,
}: {
	value: string;
	models: AgentModel[];
	allowCustom: boolean;
	onChange: (value: string) => void;
	onCustom: (value: string) => void;
	triggerLabel?: string;
	triggerClassName?: string;
	"aria-label": string;
}) {
	const { t } = useTranslation();
	const [search, setSearch] = useState("");
	const normalizedSearch = normalizeSearch(search);
	const searchIndex = useMemo(() => buildModelSearchIndex(models), [models]);
	const selected = searchIndex.byID.get(normalizeSearch(value));

	const rankedModels = useMemo(() => {
		if (!normalizedSearch) {
			return rankInitialModels(searchIndex.models, value);
		}
		return searchModelIndex(searchIndex, normalizedSearch).models;
	}, [normalizedSearch, searchIndex, value]);

	const visibleModels = rankedModels.slice(0, MAX_VISIBLE_MODELS);
	const groups = useMemo(() => groupModels(visibleModels, normalizedSearch === "", value), [visibleModels, normalizedSearch, value]);
	const customSearchValue = search.trim();
	const showCustomSearchAction = allowCustom && customSearchValue !== "" && rankedModels.length === 0;

	return (
		<DropdownMenu onOpenChange={(open) => !open && setSearch("")}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={cn(
						"settings-option-trigger max-w-full min-w-0 hover:text-settings-label focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:outline-none data-[state=open]:ring-0",
						triggerClassName,
					)}
					aria-label={ariaLabel}
				>
					<span className="min-w-0 truncate">{triggerLabel ?? selected?.label ?? t("settings.models.agentDefault")}</span>
					<ChevronDown className="size-icon-sm shrink-0 opacity-70" aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="settings-menu-surface max-h-select-menu-max! w-[min(28rem,calc(100vw-2rem))] overflow-y-auto! overflow-x-hidden! rounded-(--radius-settings-panel) border-settings-menu bg-settings-menu"
			>
				<div className="p-1" onKeyDown={(event) => event.stopPropagation()}>
					<input
						type="search"
						aria-label={t("settings.models.searchAria", { label: ariaLabel.toLocaleLowerCase() })}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t("settings.models.searchPlaceholder")}
						className="settings-inline-input w-full"
					/>
				</div>

				{normalizedSearch === "" && (
					<DropdownMenuItem onSelect={() => onChange("")} className={modelItemClass(value === "")}>
						{t("settings.models.agentDefault")}
					</DropdownMenuItem>
				)}

				{groups.map((group, groupIndex) => (
					<div key={group.name}>
						{(groupIndex > 0 || normalizedSearch === "") && <DropdownMenuSeparator />}
						<DropdownMenuLabel className="normal-case tracking-normal">{group.name}</DropdownMenuLabel>
						{group.models.map((item) => (
							<DropdownMenuItem
								key={item.id}
								onSelect={() => onChange(item.id)}
								className={modelItemClass(item.id === value)}
							>
								<div className="flex min-w-0 flex-1 items-center gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-settings-label">{item.label}</span>
											{item.model.isDefault && (
												<span className="rounded-full bg-settings-menu-selected px-1.5 py-0.5 text-micro text-settings-muted">
											{t("settings.models.default")}
												</span>
											)}
										</div>
										{item.id !== item.label && <p className="truncate text-xs text-settings-muted">{item.id}</p>}
									</div>
									{group.name !== item.provider && item.provider !== "Other" && (
										<span className="shrink-0 text-xs text-settings-muted">{item.provider}</span>
									)}
								</div>
							</DropdownMenuItem>
						))}
					</div>
				))}

				{showCustomSearchAction && (
					<DropdownMenuItem onSelect={() => onCustom(customSearchValue)} className={modelItemClass(false)}>
						{t("settings.models.useCustom", { model: customSearchValue })}
					</DropdownMenuItem>
				)}
				{normalizedSearch !== "" && rankedModels.length === 0 && !allowCustom && (
					<p className="px-2 py-1.5 text-xs text-settings-muted">{t("settings.models.noMatches")}</p>
				)}
				{normalizedSearch === "" && allowCustom && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onCustom("")} className={modelItemClass(false)}>
							{t("settings.models.custom")}
						</DropdownMenuItem>
					</>
				)}
				<p className="px-2 py-1.5 text-xs text-settings-muted" aria-live="polite">
					{t("settings.models.matchingCount", {
						visible: visibleModels.length.toLocaleString(),
						total: rankedModels.length.toLocaleString(),
					})}
					{normalizedSearch === "" && rankedModels.length > MAX_VISIBLE_MODELS ? t("settings.models.typeToNarrow") : ""}
				</p>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function normalizeSearch(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function providerFromModelID(modelID: string): string {
	const slash = modelID.indexOf("/");
	return slash > 0 ? modelID.slice(0, slash) : "";
}

export function buildModelSearchIndex(models: AgentModel[]): ModelSearchIndex {
	const indexedModels = models.map((model, index) => {
		const label = model.label || model.id;
		const provider = model.provider?.trim() || providerFromModelID(model.id) || "Other";
		return {
			model,
			id: model.id,
			label,
			provider,
			normalizedID: normalizeSearch(model.id),
			normalizedLabel: normalizeSearch(label),
			normalizedProvider: normalizeSearch(provider),
			index,
		};
	});
	const byID = new Map(indexedModels.map((item) => [item.normalizedID, item]));
	const providerBuckets = new Map<string, { models: IndexedModel[]; indexes: Set<number> }>();
	const trigramPostings = new Map<string, Set<number>>();

	for (const item of indexedModels) {
		const providerKeys = new Set([
			item.normalizedProvider,
			normalizeSearch(providerFromModelID(item.id)),
		]);
		for (const providerKey of providerKeys) {
			if (!providerKey) continue;
			const bucket = providerBuckets.get(providerKey) ?? { models: [], indexes: new Set<number>() };
			bucket.models.push(item);
			bucket.indexes.add(item.index);
			providerBuckets.set(providerKey, bucket);
		}

		const itemTrigrams = new Set([
			...trigrams(item.normalizedID),
			...trigrams(item.normalizedLabel),
			...trigrams(item.normalizedProvider),
		]);
		for (const trigram of itemTrigrams) {
			const posting = trigramPostings.get(trigram) ?? new Set<number>();
			posting.add(item.index);
			trigramPostings.set(trigram, posting);
		}
	}

	return { models: indexedModels, byID, providerBuckets, trigramPostings };
}

export function searchModelIndex(index: ModelSearchIndex, query: string): ModelSearchResult {
	const normalizedQuery = normalizeSearch(query);
	const directMatch = index.byID.get(normalizedQuery);
	if (directMatch) {
		return { models: [directMatch], candidateCount: 1, strategy: "direct" };
	}

	const provider = providerQualifier(normalizedQuery);
	const providerBucket = provider ? index.providerBuckets.get(provider) : undefined;
	const universe = providerBucket?.models ?? index.models;
	const indexedCandidates = trigramCandidates(index, normalizedQuery, providerBucket?.indexes);
	if (indexedCandidates.length > 0) {
		return {
			models: rankMatches(indexedCandidates, normalizedQuery),
			candidateCount: indexedCandidates.length,
			strategy: providerBucket ? "provider-index" : "text-index",
		};
	}

	return {
		models: rankMatches(universe, normalizedQuery),
		candidateCount: universe.length,
		strategy: "fuzzy-fallback",
	};
}

function rankInitialModels(models: IndexedModel[], selectedID: string): IndexedModel[] {
	const selected: IndexedModel[] = [];
	const defaults: IndexedModel[] = [];
	const remaining: IndexedModel[] = [];
	for (const item of models) {
		if (item.id === selectedID) selected.push(item);
		else if (item.model.isDefault) defaults.push(item);
		else remaining.push(item);
	}
	return [...selected, ...defaults, ...remaining];
}

function providerQualifier(query: string): string {
	const slash = query.indexOf("/");
	return slash > 0 ? query.slice(0, slash) : "";
}

function trigrams(value: string): string[] {
	if (value.length < 3) return [];
	const result: string[] = [];
	for (let index = 0; index <= value.length - 3; index += 1) {
		result.push(value.slice(index, index + 3));
	}
	return result;
}

function trigramCandidates(
	index: ModelSearchIndex,
	query: string,
	providerIndexes: Set<number> | undefined,
): IndexedModel[] {
	const queryTrigrams = [...new Set(trigrams(query))];
	if (queryTrigrams.length === 0) return [];
	const postings = queryTrigrams.map((trigram) => index.trigramPostings.get(trigram));
	if (postings.some((posting) => !posting)) return [];
	const completePostings = postings as Set<number>[];
	const smallestPosting = completePostings.reduce((smallest, posting) =>
		posting.size < smallest.size ? posting : smallest,
	);
	const matches: IndexedModel[] = [];
	for (const modelIndex of smallestPosting) {
		if (providerIndexes && !providerIndexes.has(modelIndex)) continue;
		if (completePostings.every((posting) => posting.has(modelIndex))) {
			matches.push(index.models[modelIndex]);
		}
	}
	return matches;
}

function rankMatches(models: IndexedModel[], query: string): IndexedModel[] {
	return models
		.map((item) => ({ item, score: modelMatchScore(item, query) }))
		.filter((match): match is { item: IndexedModel; score: number } => match.score !== null)
		.sort((a, b) => a.score - b.score || a.item.index - b.item.index)
		.map((match) => match.item);
}

function modelMatchScore(item: IndexedModel, query: string): number | null {
	const id = item.normalizedID;
	const label = item.normalizedLabel;
	const provider = item.normalizedProvider;
	if (id === query) return 0;
	if (id.startsWith(query)) return 10;
	if (label.startsWith(query)) return 20;
	if (provider.startsWith(query)) return 30;
	if (id.includes(query)) return 40;
	if (label.includes(query)) return 50;
	if (provider.includes(query)) return 60;
	const fuzzyScores = [id, label, provider]
		.map((candidate) => fuzzySubsequenceScore(candidate, query))
		.filter((score): score is number => score !== null);
	return fuzzyScores.length === 0 ? null : 100 + Math.min(...fuzzyScores);
}

function fuzzySubsequenceScore(haystack: string, needle: string): number | null {
	let searchAt = 0;
	let score = 0;
	for (const character of needle) {
		const foundAt = haystack.indexOf(character, searchAt);
		if (foundAt === -1) return null;
		score += foundAt - searchAt;
		searchAt = foundAt + 1;
	}
	return score;
}

function groupModels(models: IndexedModel[], showPinned: boolean, selectedID: string) {
	const groups = new Map<string, IndexedModel[]>();
	for (const item of models) {
		const groupName = showPinned && (item.id === selectedID || item.model.isDefault) ? "Current & defaults" : item.provider;
		const entries = groups.get(groupName) ?? [];
		entries.push(item);
		groups.set(groupName, entries);
	}
	return [...groups].map(([name, entries]) => ({ name, models: entries }));
}

function modelItemClass(selected: boolean): string {
	return cn(
		"settings-menu-item min-w-0 cursor-default outline-none",
		"focus:border-settings-menu focus:bg-settings-menu-selected focus:text-settings-label",
		"data-highlighted:border-settings-menu data-highlighted:bg-settings-menu-selected data-highlighted:text-settings-label",
		selected && "border-settings-menu bg-settings-menu-selected",
	);
}
