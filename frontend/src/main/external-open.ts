const APP_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export type ExternalOpener = {
	openExternal: (url: string) => Promise<unknown>;
};

export function isAllowedAppExternalURL(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return APP_EXTERNAL_PROTOCOLS.has(url.protocol);
	} catch {
		return false;
	}
}

export async function openAllowedAppExternalURL(rawUrl: string, opener: ExternalOpener): Promise<void> {
	if (!isAllowedAppExternalURL(rawUrl)) {
		throw new Error("Unsupported external URL");
	}
	await opener.openExternal(rawUrl);
}
