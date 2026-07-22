import { useCallback, useState } from "react";

// Client-side mirror of the backend spawn caps in
// backend/internal/httpd/controllers/sessions.go (maxAttachments /
// maxAttachmentBytes / maxAttachmentsBytes). Enforced here too so the user gets
// inline feedback at paste/drop time instead of a late rejection after submit.
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/** A single image staged for a task/orchestrator brief. */
export type ImageAttachment = {
	/** Stable id for list keys and removal. */
	id: string;
	/** Browser-reported MIME type (e.g. "image/png"). */
	mimeType: string;
	/** Decoded byte size (from File.size), used to enforce the total-size cap. */
	bytes: number;
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
				bytes: file.size,
				dataUrl,
				data: dataUrl.slice(comma + 1),
			});
		};
		reader.readAsDataURL(file);
	});

/**
 * useImageAttachments stages images pasted, dropped, or picked into a brief and
 * exposes them as upload-ready payloads. Non-image inputs are ignored so a
 * caller can wire `addFiles` straight to a paste/drop event's file list. Count
 * and size caps (mirroring the backend) are enforced here, and rejections /
 * unreadable files surface through `error` for inline feedback.
 */
export function useImageAttachments() {
	const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
	const [error, setError] = useState<string | null>(null);

	const addFiles = useCallback(
		async (files: Iterable<File>) => {
			const images = Array.from(files).filter((file) => isImageType(file.type));
			if (images.length === 0) return;

			const errors = new Set<string>();
			// Reject oversized files before the (async) read.
			const readable = images.filter((file) => {
				if (file.size > MAX_ATTACHMENT_BYTES) {
					errors.add(`Each image must be under ${mb(MAX_ATTACHMENT_BYTES)} MB.`);
					return false;
				}
				return true;
			});

			const results = await Promise.all(readable.map((file) => readImageFile(file).catch(() => null)));
			const fresh = results.filter((a): a is ImageAttachment => a !== null);
			if (fresh.length < results.length) {
				errors.add("Some images couldn't be read and were skipped.");
			}

			// Apply count/total-size caps against the current set. (Paste/drop is a
			// sequential user action, so reading current state from the closure is
			// safe; deps include `attachments` to keep it current.)
			const accepted = [...attachments];
			let total = accepted.reduce((sum, a) => sum + a.bytes, 0);
			for (const a of fresh) {
				if (accepted.length >= MAX_ATTACHMENTS) {
					errors.add(`You can attach up to ${MAX_ATTACHMENTS} images.`);
					break;
				}
				if (total + a.bytes > MAX_ATTACHMENTS_BYTES) {
					errors.add(`Attachments must total under ${mb(MAX_ATTACHMENTS_BYTES)} MB.`);
					break;
				}
				accepted.push(a);
				total += a.bytes;
			}

			if (accepted.length !== attachments.length) setAttachments(accepted);
			setError(errors.size > 0 ? Array.from(errors).join(" ") : null);
		},
		[attachments],
	);

	const remove = useCallback((id: string) => {
		setAttachments((prev) => prev.filter((a) => a.id !== id));
		setError(null);
	}, []);

	const clear = useCallback(() => {
		setAttachments([]);
		setError(null);
	}, []);

	const toPayload = useCallback(
		(): ImageAttachmentPayload[] => attachments.map(({ mimeType, data }) => ({ mimeType, data })),
		[attachments],
	);

	return { attachments, error, addFiles, remove, clear, toPayload };
}
