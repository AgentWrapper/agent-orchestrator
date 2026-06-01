import {
  disableRemoteAccess,
  enableRemoteAccess,
  getRemoteAccessInfo,
  saveRemoteAccessCredentials,
} from "@/lib/remote-access-manager";

export async function GET() {
  try {
    return Response.json(getRemoteAccessInfo());
  } catch {
    return Response.json({ enabled: false, hosts: [] });
  }
}

export async function POST() {
  try {
    return Response.json(await enableRemoteAccess());
  } catch (err) {
    return Response.json(
      { enabled: false, hosts: [], error: err instanceof Error ? err.message : "Failed to enable remote access" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return Response.json({ enabled: false, hosts: [], error: "Invalid JSON body" }, { status: 400 });
    }
    return Response.json(saveRemoteAccessCredentials(body));
  } catch (err) {
    return Response.json(
      { enabled: false, hosts: [], error: err instanceof Error ? err.message : "Failed to save remote access credentials" },
      { status: 400 },
    );
  }
}

export async function DELETE() {
  try {
    return Response.json(await disableRemoteAccess());
  } catch (err) {
    return Response.json(
      { enabled: false, hosts: [], error: err instanceof Error ? err.message : "Failed to disable remote access" },
      { status: 500 },
    );
  }
}
