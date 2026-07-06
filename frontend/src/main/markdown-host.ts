import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import { renderMarkdown, renderMarkdownSync, type RenderResult } from "./markdown-renderer";

function toFsPath(input: string): string {
	return input.startsWith("file://") ? fileURLToPath(input) : input;
}

export type MarkdownSlot = {
	filePath: string;
	html: string;
	title: string;
};

type FileChangeCallback = (filePath: string) => void;

const STABILITY_THRESHOLD_MS = 300;

export class MarkdownHost {
	private slot: MarkdownSlot | null = null;
	private watcher: ReturnType<typeof watch> | null = null;
	private onChange: FileChangeCallback | null = null;
	private currentFilePath: string | null = null;

	setOnChange(cb: FileChangeCallback | null): void {
		this.onChange = cb;
	}

	async render(filePath: string): Promise<RenderResult> {
		this.closeWatcher();

		const content = await readFile(toFsPath(filePath), "utf8");
		const result = await renderMarkdown(content, filePath);

		this.slot = { filePath, html: result.html, title: result.title };
		this.currentFilePath = filePath;
		this.startWatcher(filePath);

		return result;
	}

	getCachedHtml(): string | null {
		return this.slot?.html ?? null;
	}

	getCurrentFilePath(): string | null {
		return this.currentFilePath;
	}

	getTitle(): string | null {
		return this.slot?.title ?? null;
	}

	dispose(): void {
		this.closeWatcher();
		this.slot = null;
		this.currentFilePath = null;
		this.onChange = null;
	}

	private startWatcher(filePath: string): void {
		this.watcher = watch(toFsPath(filePath), {
			awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS },
			ignoreInitial: true,
		});

		this.watcher.on("change", async () => {
			try {
				const content = await readFile(toFsPath(filePath), "utf8");
				const result = renderMarkdownSync(content, filePath);
				this.slot = { filePath, html: result.html, title: result.title };
				this.onChange?.(filePath);
			} catch {
				// Silently ignore re-read errors (file may have been deleted/recreated).
			}
		});

		this.watcher.on("unlink", () => {
			this.slot = null;
			this.currentFilePath = null;
			this.onChange?.(filePath);
		});
	}

	private closeWatcher(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}
