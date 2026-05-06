import process from "node:process";
import { createMDX } from "fumadocs-mdx/next";

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: process.env.NODE_ENV === "production" ? "export" : undefined,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
