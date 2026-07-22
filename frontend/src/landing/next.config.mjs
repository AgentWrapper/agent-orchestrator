import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
	// Static export for GitHub Pages: no server, so images must be unoptimized
	// and every route (including /api/search via staticGET) is emitted at build.
	output: "export",
	images: { unoptimized: true },
	// Emit /docs/index.html and /docs/*/index.html so static hosts/CDNs do not
	// have to choose between a sibling docs.html file and the docs/ directory.
	trailingSlash: true,
};

const withMDX = createMDX();

export default withMDX(nextConfig);
