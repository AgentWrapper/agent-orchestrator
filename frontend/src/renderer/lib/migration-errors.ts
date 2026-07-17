import type { MigrationState } from "../../main/app-state";
import { apiErrorMessage, apiErrorSnapshot, safeExternalErrorMessage } from "./api-client";

export type MigrationActionError = { kind: "api" | "operation"; cause: unknown };

export function migrationActionError(kind: MigrationActionError["kind"], cause: unknown): MigrationActionError {
	return { kind, cause };
}

export function isMigrationActionError(error: unknown): error is MigrationActionError {
	return (
		typeof error === "object" &&
		error !== null &&
		"cause" in error &&
		"kind" in error &&
		((error as { kind?: unknown }).kind === "api" || (error as { kind?: unknown }).kind === "operation")
	);
}

export function migrationActionErrorMessage(error: unknown, fallback: string): string {
	const cause = isMigrationActionError(error) ? error.cause : error;
	return safeExternalErrorMessage(cause) ?? apiErrorMessage(cause, fallback);
}

export function migrationFailureFields(error: unknown): Pick<MigrationState, "errorCode" | "errorDetail"> {
	const snapshot = apiErrorSnapshot(error);
	return {
		...(snapshot.code ? { errorCode: snapshot.code } : {}),
		...(snapshot.detail ? { errorDetail: snapshot.detail } : {}),
	};
}

export function persistedMigrationErrorMessage(migration: MigrationState, fallback: string): string | undefined {
	if (migration.status !== "failed") return undefined;
	if (migration.errorCode) return apiErrorMessage({ code: migration.errorCode }, fallback);
	return migration.errorDetail ?? migration.error ?? fallback;
}
