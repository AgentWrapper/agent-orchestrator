import { NextResponse, type NextRequest } from "next/server";

const REALM = "AO Remote";

function remoteAuthPassword(): string | undefined {
  const password = process.env["AO_REMOTE_AUTH_PASSWORD"];
  return password && password.length > 0 ? password : undefined;
}

function remoteAuthUser(): string {
  return process.env["AO_REMOTE_AUTH_USER"] || "ao";
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}"`,
    },
  });
}

function decodeBasicAuth(header: string | null): { username: string; password: string } | null {
  const match = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!match) return null;

  try {
    const decoded = atob(match[1]);
    const separator = decoded.indexOf(":");
    if (separator === -1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const maxLength = Math.max(actual.length, expected.length);
  let diff = actual.length ^ expected.length;

  for (let i = 0; i < maxLength; i += 1) {
    diff |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }

  return diff === 0;
}

function isPublicAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon" ||
    pathname === "/apple-icon" ||
    pathname === "/icon-192" ||
    pathname === "/icon-512"
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.")
  );
}

function headerAddresses(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasExternalProxyAddress(request: NextRequest): boolean {
  const addresses = [
    ...headerAddresses(request.headers.get("x-forwarded-for")),
    ...headerAddresses(request.headers.get("x-real-ip")),
    ...headerAddresses(request.headers.get("cf-connecting-ip")),
  ];
  return addresses.some((address) => !isLoopbackAddress(address));
}

export function middleware(request: NextRequest) {
  const password = remoteAuthPassword();
  const requestIp =
    (request as NextRequest & { ip?: string }).ip ||
    (process.env["AO_TRUST_REMOTE_ADDRESS_HEADER"] === "1"
      ? (request.headers.get("x-ao-remote-address") ?? undefined)
      : undefined);
  const allowLoopbackBypass = isLoopbackAddress(requestIp) && !hasExternalProxyAddress(request);
  if (!password || isPublicAsset(request.nextUrl.pathname) || allowLoopbackBypass) {
    return NextResponse.next();
  }

  const credentials = decodeBasicAuth(request.headers.get("authorization"));
  if (!credentials) return unauthorized();

  if (
    !constantTimeEqual(credentials.username, remoteAuthUser()) ||
    !constantTimeEqual(credentials.password, password)
  ) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
