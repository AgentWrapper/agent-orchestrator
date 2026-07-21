import { useCallback, useState } from "react";

/** A single image staged for a task/orchestrator brief. */
export type ImageAttachment = {
	/** Stable id for list keys and removal. */
	id: string;
	/** Browser-reported MIME type (e.g. "image/png"). */
	mimeType: string;
	/** data: URL used to render the thumbnail preview. */
	dataUrl: string;
	/** Base64 payload without the "data:...;base64," prefix, for upload. */
	data: string;
};

/** Attachment payload shape accepted by the spawn API. */
export type ImageAttachmentPayload = {
	mimeType: string;
	data: string;
};

const isImageType = (type: string) => type.startsWith("image/");

const readImageFile = (file: File): Promise<ImageAttachment> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			const comma = dataUrl.indexOf(",");
			if (!dataUrl || comma < 0) {
				reject(new Error("Unreadable image data"));
				return;
			}
			resolve({
				id:
					typeof crypto !== "undefined" && "randomUUID" in crypto
						? crypto.randomUUID()
						: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
				mimeType: file.type || "image/png",
				dataUrl,
				data: dataUrl.slice(comma + 1),
			});
		};
		reader.readAsDataURL(file);
	});

/**
 * useImageAttachments stages images pasted, dropped, or picked into a brief and
 * exposes them as upload-ready payloads. Non-image inputs are ignored so a
 * caller can wire `addFiles` straight to a paste/drop event's file list.
 */
export function useImageAttachments() {
	const [attachments, setAttachments] = useState<ImageAttachment[]>([]);

	const addFiles = useCallback(async (files: Iterable<File>) => {
		const images = Array.from(files).filter((file) => isImageType(file.type));
		if (images.length === 0) return;
		const read = await Promise.all(images.map((file) => readImageFile(file).catch(() => null)));
		const next = read.filter((a): a is ImageAttachment => a !== null);
		if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
	}, []);

	const remove = useCallback((id: string) => {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	}, []);

	const clear = useCallback(() => setAttachments([]), []);

	const toPayload = useCallback(
		(): ImageAttachmentPayload[] => attachments.map(({ mimeType, data }) => ({ mimeType, data })),
		[attachments],
	);

	return { attachments, addFiles, remove, clear, toPayload };
}
