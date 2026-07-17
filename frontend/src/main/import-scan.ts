export type ImportRepoSetupCode = "PROJECT_UNBORN";

export function scanRepoSetupCode(
	name: string,
	isBare: boolean | undefined,
	hasHead: boolean,
): ImportRepoSetupCode | undefined {
	if (name === "__root__" || isBare !== false || hasHead) return undefined;
	return "PROJECT_UNBORN";
}
