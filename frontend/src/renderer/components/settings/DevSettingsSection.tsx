import { Beaker, Dice5, Minus, PaintBucket, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../stores/ui-store";
import { IS_DEV } from "../../lib/is-dev";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/** Dev-only settings for controlling board fixtures and UI test data. */
export function DevSettingsSection({ titleHidden }: { titleHidden?: boolean }) {
	const { t } = useTranslation();
	const devSettings = useUiStore((state) => state.devSettings);
	const setDevSettings = useUiStore((state) => state.setDevSettings);

	if (!IS_DEV) return null;

	return (
		<SettingsSection title={t("settings.dev.title")} sectionId="dev-settings" titleHidden={titleHidden}>
			<SettingsRow icon={Dice5} label={t("settings.dev.fixtureSessionsLabel")}>
				<NumberStepper
					aria-label={t("settings.dev.fixtureCountAria")}
					max={20}
					min={0}
					value={devSettings.fixtureCount}
					onChange={(fixtureCount) => setDevSettings({ ...devSettings, fixtureCount })}
				/>
			</SettingsRow>
			<SettingsRow icon={PaintBucket} label={t("settings.dev.activitySpreadLabel")}>
				<NumberStepper
					aria-label={t("settings.dev.activitySpreadAria")}
					max={480}
					min={5}
					step={5}
					value={devSettings.randomSpreadMinutes}
					onChange={(randomSpreadMinutes) => setDevSettings({ ...devSettings, randomSpreadMinutes })}
				/>
			</SettingsRow>
			<SettingsRow icon={Beaker} label={t("settings.dev.resetDefaultsLabel")}>
				<Button
					type="button"
					variant="footer"
					onClick={() => {
						setDevSettings({ fixtureCount: 8, randomSpreadMinutes: 120 });
						window.location.reload();
					}}
				>
					{t("settings.dev.resetReload")}
				</Button>
			</SettingsRow>
		</SettingsSection>
	);
}

type NumberStepperProps = {
	"aria-label": string;
	max: number;
	min: number;
	onChange: (value: number) => void;
	step?: number;
	value: number;
};

function NumberStepper({ "aria-label": ariaLabel, max, min, onChange, step = 1, value }: NumberStepperProps) {
	const { t } = useTranslation();
	const clamp = (next: number) => Math.max(min, Math.min(max, next));
	const [draft, setDraft] = useState(String(value));

	useEffect(() => {
		setDraft(String(value));
	}, [value]);

	const commit = (raw: string) => {
		const next = Number(raw);
		const clamped = Number.isNaN(next) ? min : clamp(next);
		onChange(clamped);
		setDraft(String(clamped));
	};

	return (
		<div className="flex items-center gap-1.5">
			<StepperButton
				aria-label={t("settings.dev.decreaseAria", { label: ariaLabel })}
				disabled={value <= min}
				onClick={() => onChange(clamp(value - step))}
			>
				<Minus className="size-3.5" aria-hidden="true" strokeWidth={2.25} />
			</StepperButton>
			<input
				type="number"
				aria-label={ariaLabel}
				min={min}
				max={max}
				step={step}
				value={draft}
				onChange={(event) => {
					const raw = event.target.value;
					setDraft(raw);
					if (raw === "" || raw === "-") return;
					const next = Number(raw);
					if (!Number.isNaN(next)) onChange(clamp(next));
				}}
				onBlur={() => commit(draft)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					}
				}}
				className={cn(
					"h-7 w-12 rounded-md border-0 bg-transparent px-1 text-center text-sm tabular-nums text-settings-label outline-none",
					"focus-visible:shadow-[0_0_0_2px_var(--bridge-accent-weak)]",
					"[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
				)}
			/>
			<StepperButton
				aria-label={t("settings.dev.increaseAria", { label: ariaLabel })}
				disabled={value >= max}
				onClick={() => onChange(clamp(value + step))}
			>
				<Plus className="size-3.5" aria-hidden="true" strokeWidth={2.25} />
			</StepperButton>
		</div>
	);
}

function StepperButton({
	"aria-label": ariaLabel,
	children,
	disabled,
	onClick,
}: {
	"aria-label": string;
	children: ReactNode;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-full",
				"bg-(--color-bg-settings-input) text-settings-muted",
				"transition-colors hover:text-settings-label",
				"focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--bridge-accent-weak)]",
				"disabled:pointer-events-none disabled:opacity-40",
			)}
		>
			{children}
		</button>
	);
}
