import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL("/api/filesystem/browse", request.url);
  url.search = request.nextUrl.search;
  return NextResponse.redirect(url, 307);
}
