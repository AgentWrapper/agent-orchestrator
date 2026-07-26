import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,

  images: {
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

  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
      {
        source: "/ingest/decide",
        destination: "https://us.i.posthog.com/decide",
      },
    ];
  },

  async redirects() {
    return [
      {
        source: "/about",
        destination: "/team",
        permanent: true,
      },
      {
        source: "/docs/:path*",
        destination: "https://docs.superset.sh/:path*",
        permanent: false,
      },
    ];
  },

  skipTrailingSlashRedirect: true,
};

export default config;
