import type { InputProperty } from "./types";

export function initialInputValue(property: InputProperty): unknown {
	if (property.default !== undefined) return property.default;
	if (property.type === "array") return [];
	if (property.type === "boolean") return false;
	return "";
}

export function inputOptions(property: InputProperty): Array<{ value: string; label: string; description?: string }> {
	const candidates = property.oneOf ?? property.items?.anyOf;
	if (candidates?.length) {
		return candidates.flatMap((candidate) => typeof candidate.const === "string"
			? [{ value: candidate.const, label: candidate.title || candidate.const, description: candidate.description }]
			: []);
	}
	return (property.enum ?? []).flatMap((value) => typeof value === "string"
		? [{ value, label: value }]
		: []);
}

export function toggleInputValue(values: unknown[], value: string): string[] {
	const strings = values.filter((item): item is string => typeof item === "string");
	return strings.includes(value) ? strings.filter((item) => item !== value) : [...strings, value];
}

export function missingRequiredInputs(required: string[] | undefined, values: Record<string, unknown>): string[] {
	return (required ?? []).filter((name) => {
		const value = values[name];
		return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
	});
}

export function validateInput(property: InputProperty, value: unknown): string | undefined {
	if (typeof value === "string") {
		if (property.minLength !== undefined && value.length < property.minLength) return `must be at least ${property.minLength} characters`;
		if (property.maxLength !== undefined && value.length > property.maxLength) return `must be at most ${property.maxLength} characters`;
	}
	if ((property.type === "number" || property.type === "integer") && typeof value === "number") {
		if (!Number.isFinite(value)) return "must be a number";
		if (property.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
		if (property.minimum !== undefined && value < property.minimum) return `must be at least ${property.minimum}`;
		if (property.maximum !== undefined && value > property.maximum) return `must be at most ${property.maximum}`;
	}
	return undefined;
}

export function humanizeInputName(value: string): string {
	return value.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function safeHttpURL(value: unknown): URL | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
	} catch {
		return undefined;
	}
}
