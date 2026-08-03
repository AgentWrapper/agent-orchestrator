import { signOut } from "@workos-inc/authkit-nextjs";

export async function GET() {
  await signOut({ returnTo: "/auth" });
}

export const POST = GET;
