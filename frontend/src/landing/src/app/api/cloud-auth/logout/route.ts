import { signOut } from "@workos-inc/authkit-nextjs";

export async function GET() {
  await signOut({ returnTo: workOSLogoutReturnTo() });
}

export const POST = GET;

export function workOSLogoutReturnTo() {
  const webURL = process.env.NEXT_PUBLIC_WEB_URL;
  if (!webURL) return "/auth";
  return new URL("/auth", webURL).toString();
}
