import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, ArrowUp, Folder, LoaderCircle, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import type { ProjectKind } from "../types/workspace";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./ui/breadcrumb";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type ListDirectoriesResponse = components["schemas"]["ListDirectoriesResponse"];

export type RemoteDirectoryPickerDialogProps = {
	disabled: boolean;
	kind: ProjectKind;
	onOpenChange: (open: boolean) => void;
	onSelect: (path: string) => void;
	open: boolean;
};

export function RemoteDirectoryPickerDialog({
	disabled,
	kind,
	onOpenChange,
	onSelect,
	open,
}: RemoteDirectoryPickerDialogProps) {
	const [current, setCurrent] = useState<ListDirectoriesResponse | null>(null);
	const [path, setPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const requestNumber = useRef(0);

	const openPath = useCallback(async (nextPath?: string) => {
		const request = ++requestNumber.current;
		setLoading(true);
		setError(null);
		try {
			const { data, error: apiError } = await apiClient.GET("/api/v1/filesystem/directories", {
				params: nextPath ? { query: { path: nextPath } } : undefined,
			});
			if (request !== requestNumber.current) return;
			if (apiError) {
				setError(apiErrorMessage(apiError, "Could not load server directories"));
				return;
			}
			if (data) {
				setCurrent(data);
				setPath(data.path);
			}
		} catch (err) {
			if (request === requestNumber.current) {
				setError(apiErrorMessage(err, "Could not load server directories"));
			}
		} finally {
			if (request === requestNumber.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void openPath();
		return () => {
			requestNumber.current += 1;
		};
	}, [open, openPath]);

	const submitPath = (event: FormEvent) => {
		event.preventDefault();
		const normalized = path.trim();
		if (normalized) void openPath(normalized);
	};

	const isWorkspace = kind === "workspace";
	const breadcrumbs = current ? directoryBreadcrumbs(current.path) : [];

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(680px,calc(100svh-24px))] w-[min(620px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6 sm:py-5">
						<div className="min-w-0">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								Browse server {isWorkspace ? "workspace" : "project"} folders
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
								Choose a folder on the server running Agent Orchestrator.
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<Button type="button" variant="ghost" size="icon-sm" aria-label="Close server folder browser" disabled={disabled}>
								<X className="size-4" aria-hidden="true" />
							</Button>
						</Dialog.Close>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-4 sm:px-6">
						<form className="flex items-end gap-2" onSubmit={submitPath}>
							<div className="min-w-0 flex-1">
								<Label htmlFor="remote-directory-path" className="mb-1.5 block text-xs text-muted-foreground">
									Server path
								</Label>
								<Input
									id="remote-directory-path"
									className="font-mono"
									value={path}
									onChange={(event) => setPath(event.target.value)}
									placeholder="/home/claude/code/project"
									disabled={disabled}
								/>
							</div>
							<Button
								type="submit"
								variant="outline"
								size="icon"
								aria-label="Go"
								title="Go"
								disabled={disabled || loading || !path.trim()}
							>
								<ArrowRight className="size-4" aria-hidden="true" />
							</Button>
						</form>

						<div className="flex min-h-8 items-center gap-2">
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label="Up"
								title="Up"
								disabled={disabled || loading || !current?.parent}
								onClick={() => current?.parent && void openPath(current.parent)}
							>
								<ArrowUp className="size-4" aria-hidden="true" />
							</Button>
							<Breadcrumb className="min-w-0 flex-1 overflow-hidden">
								<BreadcrumbList className="overflow-hidden font-mono text-xs">
									{breadcrumbs.map((breadcrumb, index) => (
										<Fragment key={breadcrumb.path}>
											{index > 0 && <BreadcrumbSeparator />}
											<BreadcrumbItem>
												{index === breadcrumbs.length - 1 ? (
													<BreadcrumbPage>{breadcrumb.label}</BreadcrumbPage>
												) : (
													<button
														type="button"
														className="truncate text-muted-foreground hover:text-foreground"
														aria-label={`Go to ${breadcrumb.path}`}
														disabled={disabled || loading}
														onClick={() => void openPath(breadcrumb.path)}
													>
														{breadcrumb.label}
													</button>
												)}
											</BreadcrumbItem>
										</Fragment>
									))}
								</BreadcrumbList>
							</Breadcrumb>
						</div>

						<div className="h-64 overflow-y-auto rounded-md border border-border bg-background">
							{loading ? (
								<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
									<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
									Loading folders...
								</div>
							) : current?.directories.length ? (
								<div className="p-1.5">
									{current.directories.map((directory) => (
										<button
											type="button"
											key={directory.path}
											className="flex h-10 w-full items-center gap-2 rounded-md px-2.5 text-left font-mono text-sm text-foreground hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
											aria-label={`Open ${directory.name}`}
											disabled={disabled}
											onClick={() => void openPath(directory.path)}
										>
											<Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
											<span className="truncate">{directory.name}</span>
										</button>
									))}
								</div>
							) : current ? (
								<div className="flex h-full items-center justify-center text-sm text-muted-foreground">No folders</div>
							) : null}
						</div>
						{error && (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						)}
					</div>

					<div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-4 sm:px-6">
						<Button type="button" variant="outline" disabled={disabled} onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button
							type="button"
							variant="primary"
							disabled={disabled || loading || !current}
							onClick={() => current && onSelect(current.path)}
						>
							Select this folder
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function directoryBreadcrumbs(path: string): Array<{ label: string; path: string }> {
	if (!path.startsWith("/")) return [{ label: path, path }];
	const breadcrumbs = [{ label: "/", path: "/" }];
	let currentPath = "";
	for (const segment of path.split("/").filter(Boolean)) {
		currentPath += `/${segment}`;
		breadcrumbs.push({ label: segment, path: currentPath });
	}
	return breadcrumbs;
}
