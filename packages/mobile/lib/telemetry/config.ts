// PostHog project the mobile app reports to.
//
// This is the APP project, the same one the desktop app uses, so desktop and
// mobile usage sit together and split by the `client` context property. The
// marketing site is a separate project. The key is a public project key (it
// ships in every client build by design, like the desktop's), not a secret, so
// hardcoding it mirrors the desktop's shared constant. An EXPO_PUBLIC_ override
// lets a build point elsewhere without a code change.
export const MOBILE_POSTHOG_KEY =
	process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim() || "phc_uXAqS8nokL2QLSGBZSEMHTUNVXsFeXu3SrcWG7fjEyVH";

export const MOBILE_POSTHOG_HOST =
	process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";
