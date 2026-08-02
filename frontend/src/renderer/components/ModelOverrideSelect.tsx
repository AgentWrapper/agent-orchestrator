import { useEffect, useRef, useState, type ReactElement } from "react";
import { SettingsOptionMenu } from "./settings/SettingsOptionMenu";
import { Input } from "./ui/input";

const INHERIT_VALUE = "__inherit__";
const CUSTOM_VALUE = "__custom__";

export type ModelOverrideSelectProps = {
	ariaLabel: string;
	value: string;
	onChange: (value: string) => void;
	inheritLabel?: string;
};

export const CODEX_MODEL_OPTIONS = [
	{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol", description: "Latest frontier agentic coding model" },
	{ value: "gpt-5.6-terra", label: "GPT-5.6 Terra", description: "Balanced coding model for everyday work" },
	{ value: "gpt-5.6-luna", label: "GPT-5.6 Luna", description: "Fast and affordable agentic coding model" },
	{ value: "gpt-5.5", label: "GPT-5.5", description: "Frontier model for complex coding and research" },
] as const;

const MODEL_DESCRIPTIONS = new Map<string, string>(
	CODEX_MODEL_OPTIONS.map((option) => [option.value, option.description]),
);

export function ModelOverrideSelect({
	ariaLabel,
	value,
	onChange,
	inheritLabel = "Agent default",
}: ModelOverrideSelectProps): ReactElement {
	const known = CODEX_MODEL_OPTIONS.some((option) => option.value === value);
	const [customMode, setCustomMode] = useState(value !== "" && !known);
	const [customDraft, setCustomDraft] = useState(known ? "" : value);
	const localCustomEdit = useRef<string | null>(null);
	const selectValue = customMode ? CUSTOM_VALUE : value || INHERIT_VALUE;

	useEffect(() => {
		if (localCustomEdit.current === value) {
			localCustomEdit.current = null;
			return;
		}
		localCustomEdit.current = null;
		if (value === "" || CODEX_MODEL_OPTIONS.some((option) => option.value === value)) {
			setCustomMode(false);
		} else {
			setCustomMode(true);
			setCustomDraft(value);
		}
	}, [value]);

	function handleValueChange(next: string) {
		if (next === CUSTOM_VALUE) {
			setCustomDraft(known ? "" : value);
			setCustomMode(true);
			return;
		}
		setCustomMode(false);
		onChange(next === INHERIT_VALUE ? "" : next);
	}

	const options = [
		{ value: INHERIT_VALUE, label: inheritLabel },
		...CODEX_MODEL_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
		{ value: CUSTOM_VALUE, label: "Custom model ID" },
	];

	return (
		<div className="flex min-w-0 flex-1 flex-col items-end gap-2">
			<SettingsOptionMenu
				aria-label={ariaLabel}
				value={selectValue}
				options={options}
				onChange={handleValueChange}
				renderMenuItem={(option) => {
					const description = MODEL_DESCRIPTIONS.get(option.value);
					return (
						<span className="flex flex-col items-start gap-0.5">
							<span>{option.label}</span>
							{description ? <span className="text-xs text-settings-muted">{description}</span> : null}
						</span>
					);
				}}
			/>
			{customMode ? (
				<Input
					aria-label="Custom model ID"
					className="h-control-form w-full"
					value={customDraft}
					onChange={(event) => {
						const next = event.target.value;
						setCustomDraft(next);
						localCustomEdit.current = next;
						onChange(next);
					}}
					placeholder="Enter exact model ID"
				/>
			) : null}
		</div>
	);
}
