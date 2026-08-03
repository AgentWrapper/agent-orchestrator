import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

function displayName(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const name = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || user.email || "";
}

export async function GET() {
  const session = await withAuth();
  if (!session.user || !session.accessToken) {
    return NextResponse.json(
      { message: "WorkOS session is required." },
      { status: 401 },
    );
  }
  return NextResponse.json({
    accessToken: session.accessToken,
    authProvider: "workos",
    user: {
      id: session.user.id,
      email: session.user.email,
      displayName: displayName(session.user),
    },
  });
}
