import { buildPwaManifest } from "@/lib/pwa-manifest";

export function GET() {
  const manifest = buildPwaManifest();
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
