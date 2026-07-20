import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
	// Static export for GitHub Pages: no server, so images must be unoptimized
	// and every route (including /api/search via staticGET) is emitted at build.
	output: "export",
	images: { unoptimized: true },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
