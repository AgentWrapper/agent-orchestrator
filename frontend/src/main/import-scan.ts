export type ImportRepoSetupCode = "PROJECT_UNBORN";

export type ImportRepoValidationCode =
	| "LINKED_WORKTREE"
	| "BARE_REPOSITORY"
	| "RESERVED_NAME"
	| "NO_COMMITS"
	| "NO_CHECKED_OUT_BRANCH"
	| "NO_ORIGIN_REMOTE";

export function scanRepoSetupCode(
	name: string,
	isBare: boolean | undefined,
	hasHead: boolean,
): ImportRepoSetupCode | undefined {
	if (name === "__root__" || isBare !== false || hasHead) return undefined;
	return "PROJECT_UNBORN";
}

export function scanRepoValidationCode(
	name: string,
	branch: string,
	hasRemote: boolean,
	isBare: boolean,
	hasHead: boolean,
): ImportRepoValidationCode | undefined {
	if (name === "__root__") return "RESERVED_NAME";
	if (isBare) return "BARE_REPOSITORY";
	if (!hasHead) return "NO_COMMITS";
	if (branch === "HEAD") return "NO_CHECKED_OUT_BRANCH";
	if (!hasRemote) return "NO_ORIGIN_REMOTE";
	return undefined;
}
