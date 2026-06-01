import { NextResponse } from "next/server";
import { activeRemoteAuth, createRemoteWsToken } from "../../../../../server/remote-auth";

export const dynamic = "force-dynamic";

function normalizePort(input: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(input ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return String(parsed);
  }
  return String(fallback);
}

function normalizeProxyPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

export async function GET() {
  const terminalPort = normalizePort(process.env.TERMINAL_PORT, 14800);
  const directTerminalPort = normalizePort(process.env.DIRECT_TERMINAL_PORT, 14801);
  const proxyWsPath = normalizeProxyPath(
    process.env.TERMINAL_WS_PATH ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
  );
  const remoteAuth = activeRemoteAuth();
  const remoteWsToken = remoteAuth.password ? createRemoteWsToken(remoteAuth) : undefined;

  return NextResponse.json(
    { terminalPort, directTerminalPort, proxyWsPath, remoteWsToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}
