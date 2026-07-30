import { ChevronRight } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ReverbTopbarModel } from "./topbar-model";

export interface ReverbTopbarProps {
	model: ReverbTopbarModel;
	leadingIcon?: ReactNode;
	error?: ReactNode;
	actions?: ReactNode;
	utilities?: ReactNode;
	separateUtilities?: boolean;
	dragStyle?: CSSProperties;
	className?: string;
}

function interactiveStyleFor(dragStyle: CSSProperties | undefined): CSSProperties | undefined {
	const appRegion = (dragStyle as (CSSProperties & { WebkitAppRegion?: string }) | undefined)?.WebkitAppRegion;
	return appRegion === "drag" ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;
}

/**
 * Shared Reverb workspace-bar presentation.
 *
 * Route adaptation and behavior live outside this component. Callers provide
 * already-wired action, utility, and state nodes through the corresponding
 * slots.
 */
export function ReverbTopbar({
	model,
	leadingIcon,
	error,
	actions,
	utilities,
	separateUtilities = true,
	dragStyle,
	className,
}: ReverbTopbarProps) {
	const explicitCurrentIndex = model.breadcrumbs.findIndex((breadcrumb) => breadcrumb.current);
	const currentIndex = explicitCurrentIndex >= 0 ? explicitCurrentIndex : model.breadcrumbs.length - 1;
	const noDragStyle = interactiveStyleFor(dragStyle);
	const hasRouteControls = Boolean(error || actions);

	return (
		<header
			aria-label={model.ariaLabel ?? "Reverb workspace"}
			className={cn(
				"reverb-topbar center-panel-titlebar grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border z-chrome",
				className,
			)}
			data-surface={model.surface}
			style={dragStyle}
		>
			<div className="reverb-topbar__context flex min-w-0 items-center gap-2">
				{leadingIcon ? (
					<span aria-hidden="true" className="reverb-topbar__leading-icon inline-flex shrink-0 items-center">
						{leadingIcon}
					</span>
				) : null}

				{model.breadcrumbs.length > 0 ? (
					<nav
						aria-label={model.breadcrumbAriaLabel ?? "Workspace breadcrumb"}
						className="reverb-topbar__breadcrumbs min-w-0"
						style={noDragStyle}
					>
						<ol className="reverb-topbar__breadcrumb-list flex min-w-0 items-center">
							{model.breadcrumbs.map((breadcrumb, index) => {
								const isCurrent = index === currentIndex;
								const breadcrumbClassName = cn(
									"reverb-topbar__breadcrumb inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap leading-none",
									isCurrent ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
								);
								const breadcrumbContent = (
									<>
										{breadcrumb.icon ? (
											<span
												aria-hidden="true"
												className="reverb-topbar__breadcrumb-icon inline-flex shrink-0 items-center"
											>
												{breadcrumb.icon}
											</span>
										) : null}
										<span className="reverb-topbar__breadcrumb-label truncate">{breadcrumb.label}</span>
									</>
								);

								return (
									<li className="reverb-topbar__breadcrumb-group contents" key={breadcrumb.id}>
										{index > 0 ? (
											<ChevronRight
												aria-hidden="true"
												className="reverb-topbar__separator size-3.5 shrink-0 text-passive"
												focusable="false"
											/>
										) : null}
										{breadcrumb.onClick && !isCurrent ? (
											<button
												className={cn(breadcrumbClassName, "reverb-topbar__breadcrumb--interactive")}
												onClick={breadcrumb.onClick}
												style={noDragStyle}
												title={breadcrumb.title}
												type="button"
											>
												{breadcrumbContent}
											</button>
										) : (
											<span
												aria-current={isCurrent ? "page" : undefined}
												className={breadcrumbClassName}
												title={breadcrumb.title}
											>
												{breadcrumbContent}
											</span>
										)}
									</li>
								);
							})}
						</ol>
					</nav>
				) : null}
			</div>

			<div className="reverb-topbar__trailing flex min-w-0 items-center justify-end">
				{error ? (
					<div className="reverb-topbar__error min-w-0" style={noDragStyle}>
						{error}
					</div>
				) : null}

				{actions ? (
					<div
						aria-label={model.actionsAriaLabel ?? "Page actions"}
						className="reverb-topbar__actions flex shrink-0 items-center"
						role="group"
						style={noDragStyle}
					>
						{actions}
					</div>
				) : null}

				{separateUtilities && hasRouteControls && utilities ? (
					<span aria-hidden="true" className="reverb-topbar__utility-separator shrink-0" />
				) : null}

				{utilities ? (
					<div
						aria-label={model.utilitiesAriaLabel ?? "Global utilities"}
						className="reverb-topbar__utilities flex shrink-0 items-center"
						role="group"
						style={noDragStyle}
					>
						{utilities}
					</div>
				) : null}
			</div>
		</header>
	);
}
