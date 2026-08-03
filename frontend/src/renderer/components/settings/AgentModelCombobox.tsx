import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
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
	index: number;
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
	const [search, setSearch] = useState("");
	const normalizedSearch = normalizeSearch(search);
	const indexedModels = useMemo(
		() =>
			models.map((model, index) => {
				const label = model.label || model.id;
				const provider = model.provider?.trim() || providerFromModelID(model.id) || "Other";
				return {
					model,
					id: model.id,
					label,
					provider,
					index,
				};
			}),
		[models],
	);
	const modelByID = useMemo(() => new Map(indexedModels.map((item) => [item.id, item])), [indexedModels]);
	const selected = modelByID.get(value);

	const rankedModels = useMemo(() => {
		if (!normalizedSearch) {
			return [...indexedModels].sort((a, b) => {
				const aRank = a.id === value ? 0 : a.model.isDefault ? 1 : 2;
				const bRank = b.id === value ? 0 : b.model.isDefault ? 1 : 2;
				return aRank - bRank || a.index - b.index;
			});
		}
		return indexedModels
			.map((item) => ({ item, score: modelMatchScore(item, normalizedSearch) }))
			.filter((match) => match.score !== null)
			.sort((a, b) => (a.score ?? 0) - (b.score ?? 0) || a.item.index - b.item.index)
			.map((match) => match.item);
	}, [indexedModels, normalizedSearch, value]);

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
					<span className="min-w-0 truncate">{triggerLabel ?? selected?.label ?? "Agent default"}</span>
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
						aria-label={`Search ${ariaLabel.toLowerCase()}`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder="Search models or providers…"
						className="settings-inline-input w-full"
					/>
				</div>

				{normalizedSearch === "" && (
					<DropdownMenuItem onSelect={() => onChange("")} className={modelItemClass(value === "")}>
						Agent default
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
													Default
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
						Use “{customSearchValue}” as a custom model
					</DropdownMenuItem>
				)}
				{normalizedSearch !== "" && rankedModels.length === 0 && !allowCustom && (
					<p className="px-2 py-1.5 text-xs text-settings-muted">No matching models.</p>
				)}
				{normalizedSearch === "" && allowCustom && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onCustom("")} className={modelItemClass(false)}>
							Custom model…
						</DropdownMenuItem>
					</>
				)}
				<p className="px-2 py-1.5 text-xs text-settings-muted" aria-live="polite">
					Showing {visibleModels.length.toLocaleString()} of {rankedModels.length.toLocaleString()} matching models
					{normalizedSearch === "" && rankedModels.length > MAX_VISIBLE_MODELS ? " — type to narrow" : ""}
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

function modelMatchScore(item: IndexedModel, query: string): number | null {
	const id = normalizeSearch(item.id);
	const label = normalizeSearch(item.label);
	const provider = normalizeSearch(item.provider);
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
