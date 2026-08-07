export function formatTokenCount(totalTokens: number): string {
	const tokens = Math.max(0, Math.trunc(totalTokens));
	if (tokens < 1_000) return `${tokens.toLocaleString("en-US")} tok`;
	if (tokens < 1_000_000) return `${formatUnit(tokens / 1_000)}K tok`;
	if (tokens < 1_000_000_000) return `${formatUnit(tokens / 1_000_000)}M tok`;
	return `${formatUnit(tokens / 1_000_000_000)}B tok`;
}

function formatUnit(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}
