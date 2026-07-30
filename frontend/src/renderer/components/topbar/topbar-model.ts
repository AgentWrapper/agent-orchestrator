import type { ReactNode } from "react";

/**
 * The normal Reverb routes that can own a workspace bar. The first-launch
 * welcome screen intentionally does not mount one.
 */
export const reverbTopbarSurfaces = [
	"global-board",
	"project-board",
	"worker-session",
	"orchestrator-session",
	"global-settings",
	"project-settings",
	"standalone-terminals",
] as const;

export type ReverbTopbarSurface = (typeof reverbTopbarSurfaces)[number];

/**
 * A display-only breadcrumb. Navigation remains the responsibility of the
 * route/controller layer; this model only describes the visible hierarchy.
 */
export interface ReverbTopbarBreadcrumb {
	id: string;
	label: string;
	icon?: ReactNode;
	current?: boolean;
	title?: string;
	onClick?: () => void;
}

/**
 * Stable, serial-data-adjacent information consumed by the shared top-bar
 * presentation. Interactive controls are passed to ReverbTopbar as slots so
 * this model never owns routing, daemon calls, or mutations.
 */
export interface ReverbTopbarModel {
	surface: ReverbTopbarSurface;
	breadcrumbs: readonly ReverbTopbarBreadcrumb[];
	ariaLabel?: string;
	breadcrumbAriaLabel?: string;
	contextAriaLabel?: string;
	actionsAriaLabel?: string;
	utilitiesAriaLabel?: string;
}
