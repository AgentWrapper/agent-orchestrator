import { useEffect, useMemo, useState } from "react";
import { Braces, LayoutTemplate, Plus } from "lucide-react";
import { PIPELINE_TEMPLATES, type PipelineTemplate } from "../lib/pipeline-templates";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

// NewPipelineModal is the "New pipeline" entry point (mockup 1e), restyled to
// AO tokens. It only decides HOW a new draft starts: a blank canvas, one of
// the three built-in templates (lib/pipeline-templates.ts), or an imported
// YAML document. The caller (PipelineDefinitionsPage) turns the choice into an
// initial YAML buffer and opens the same visual editor every path shares.

export type NewPipelineChoice =
	{ kind: "blank" } | { kind: "template"; template: PipelineTemplate } | { kind: "yaml"; yamlSource: string };

type Path = "blank" | "template" | "yaml";

const PATH_CARDS: { key: Path; label: string; caption: string; icon: typeof Plus }[] = [
	{ key: "blank", label: "Blank canvas", caption: "Drag stages onto an empty graph", icon: Plus },
	{ key: "template", label: "From template", caption: "Start from a proven pipeline", icon: LayoutTemplate },
	{ key: "yaml", label: "Paste YAML", caption: "Import an existing definition", icon: Braces },
];

// Stage counts only depend on the static templates, not on anything the modal
// renders per instance, so compute them once instead of per row per render.
const TEMPLATE_STAGE_COUNTS: Record<string, number> = Object.fromEntries(
	PIPELINE_TEMPLATES.map((template) => [template.id, template.draft().stages.length]),
);

export function NewPipelineModal({
	open,
	onCancel,
	onCreate,
}: {
	open: boolean;
	onCancel: () => void;
	onCreate: (choice: NewPipelineChoice) => void;
}) {
	const [path, setPath] = useState<Path>("blank");
	const [templateId, setTemplateId] = useState<PipelineTemplate["id"] | null>(null);
	const [yamlText, setYamlText] = useState("");

	// Reseed every time the modal opens, same convention as PipelineSettingsModal:
	// a dismissed modal never leaks its half-filled state into the next open.
	useEffect(() => {
		if (open) {
			setPath("blank");
			setTemplateId(null);
			setYamlText("");
		}
	}, [open]);

	const selectedTemplate = useMemo(() => PIPELINE_TEMPLATES.find((t) => t.id === templateId) ?? null, [templateId]);

	const createDisabled = (path === "template" && !selectedTemplate) || (path === "yaml" && yamlText.trim() === "");

	const create = () => {
		if (path === "blank") onCreate({ kind: "blank" });
		else if (path === "template" && selectedTemplate) onCreate({ kind: "template", template: selectedTemplate });
		else if (path === "yaml") onCreate({ kind: "yaml", yamlSource: yamlText });
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent showCloseButton={false} aria-describedby={undefined} className="max-w-2xl">
				<DialogHeader className="flex-row items-center justify-between">
					<div className="min-w-0">
						<DialogTitle>New pipeline</DialogTitle>
						<p className="mt-0.5 text-caption text-passive">
							Author visually. YAML is generated and validated on save.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Button variant="outline" size="sm" onClick={onCancel}>
							Cancel
						</Button>
						<Button size="sm" variant="primary" disabled={createDisabled} onClick={create}>
							Create
						</Button>
					</div>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					<div role="radiogroup" aria-label="Creation path" className="grid grid-cols-3 gap-2.5">
						{PATH_CARDS.map(({ key, label, caption, icon: Icon }) => {
							const selected = path === key;
							return (
								<button
									key={key}
									type="button"
									role="radio"
									aria-checked={selected}
									onClick={() => setPath(key)}
									className={cn(
										"flex flex-col items-start gap-1.5 rounded-md border p-3 text-left transition-colors",
										selected
											? "border-accent bg-accent/10"
											: "border-border bg-surface hover:border-accent-dim hover:bg-raised",
									)}
								>
									<Icon
										className={cn("size-icon-md", selected ? "text-accent" : "text-muted-foreground")}
										aria-hidden="true"
									/>
									<span className="text-control font-medium text-foreground">{label}</span>
									<span className="text-caption text-passive">{caption}</span>
								</button>
							);
						})}
					</div>

					{path === "yaml" ? (
						<div className="flex flex-col gap-1.5">
							<FieldLabel>Paste YAML</FieldLabel>
							<textarea
								aria-label="Paste YAML"
								rows={10}
								value={yamlText}
								onChange={(e) => setYamlText(e.target.value)}
								placeholder={"name: my-pipeline\nstages:\n  - name: review\n    ..."}
								className="w-full resize-y rounded-md border border-border bg-transparent px-3 py-2 font-mono text-caption leading-relaxed text-foreground outline-none transition placeholder:text-passive focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-weak"
							/>
						</div>
					) : (
						<div className="flex flex-col gap-1.5">
							<FieldLabel>Templates</FieldLabel>
							<div role="radiogroup" aria-label="Templates" className="flex flex-col gap-1.5">
								{PIPELINE_TEMPLATES.map((template) => {
									const selected = path === "template" && templateId === template.id;
									return (
										<button
											key={template.id}
											type="button"
											role="radio"
											aria-checked={selected}
											aria-label={template.name}
											onClick={() => {
												setTemplateId(template.id);
												setPath("template");
											}}
											className={cn(
												"flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
												selected
													? "border-accent bg-accent/10"
													: "border-border bg-surface hover:border-accent-dim hover:bg-raised",
											)}
										>
											<span className={cn("size-1.5 shrink-0 rounded-full", template.dotClass)} aria-hidden="true" />
											<div className="min-w-0 flex-1">
												<div className="truncate text-control text-foreground">{template.name}</div>
												<div className="truncate text-caption text-passive">{template.description}</div>
											</div>
											<span className="shrink-0 font-mono text-caption text-muted-foreground">
												{TEMPLATE_STAGE_COUNTS[template.id]} stages
											</span>
										</button>
									);
								})}
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <span className="font-mono text-micro font-medium uppercase tracking-wide text-passive">{children}</span>;
}
