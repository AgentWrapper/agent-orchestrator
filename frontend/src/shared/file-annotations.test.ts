import { describe, expect, it } from "vitest";
import {
	formatFileAnnotationMessage,
	MAX_FILE_ANNOTATION_MESSAGE_LENGTH,
	type FileAnnotationTarget,
} from "./file-annotations";

describe("formatFileAnnotationMessage", () => {
	it("formats precise new-side line context for the session agent", () => {
		const target: FileAnnotationTarget = {
			path: "src/App.tsx",
			side: "new",
			line: 42,
			oldLine: 41,
			newLine: 42,
			lineKind: "add",
			lineText: "return <Button />;",
		};

		const message = formatFileAnnotationMessage(target, "Use the shared primary action here.");

		expect(message).toContain("Use the shared primary action here.");
		expect(message).toContain("- Path: src/App.tsx");
		expect(message).toContain("- Location: New side, line 42");
		expect(message).toContain("- Code: return <Button />;");
	});

	it("supports whole-file feedback and caps the injected message", () => {
		const message = formatFileAnnotationMessage(
			{ path: "README.md", previousPath: "README.old.md", side: "file" },
			"x".repeat(10_000),
		);

		expect(message).toContain("- Location: Entire file");
		expect(message).toContain("- Previous path: README.old.md");
		expect(message.length).toBeLessThanOrEqual(MAX_FILE_ANNOTATION_MESSAGE_LENGTH);
	});
});
