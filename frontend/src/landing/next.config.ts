import type { NextConfig } from "next";

const usesServerAuth =
	process.env.NEXT_PUBLIC_AO_AUTH_MODE === "workos" ||
	process.env.AO_CLOUD_AUTH_MODE === "workos";

// GitHub Pages serves a static export (see .github/workflows/deploy-landing.yml).
// Cloud auth runs through live Next route handlers, so local WorkOS testing must
// opt out of static export.
const config: NextConfig = {
	output: usesServerAuth ? undefined : "export",
	reactStrictMode: true,
	trailingSlash: usesServerAuth ? false : true,
	images: {
		unoptimized: true,
		qualities: [75, 80],
		remotePatterns: [
			{
				protocol: "https",
				hostname: "*.public.blob.vercel-storage.com",
			},
			{
				protocol: "https",
				hostname: "unavatar.io",
			},
		],
	},
};

export default config;
