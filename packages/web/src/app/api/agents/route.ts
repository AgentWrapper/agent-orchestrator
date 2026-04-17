import { getServices } from "@/lib/services";

/** GET /api/agents — List registered agent plugins */
export async function GET() {
  const { registry } = await getServices();
  const manifests = registry.list("agent");
  const agents = manifests.map(({ name, displayName, description }) => ({
    name,
    displayName,
    description,
  }));
  return Response.json({ agents });
}
