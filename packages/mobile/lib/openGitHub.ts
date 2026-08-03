import { Linking } from "react-native";
import { githubAppUrl } from "./githubLink";

// Opens a github.com URL in the GitHub app when it's installed, and in the
// browser otherwise. The app is preferred because it carries the user's session:
// a private repo or PR opened in the phone's browser shows a login wall or a 404.
//
// Every failure path falls through to the browser, so the worst case is exactly
// the behaviour we had before. On iOS `canOpenURL` also needs "github" listed in
// LSApplicationQueriesSchemes (see app.json) or it always answers false.
export async function openGitHub(url: string): Promise<void> {
	const appUrl = githubAppUrl(url);
	if (appUrl) {
		try {
			if (await Linking.canOpenURL(appUrl)) {
				await Linking.openURL(appUrl);
				return;
			}
		} catch {
			// Fall through to the browser.
		}
	}
	await Linking.openURL(url).catch(() => {});
}
