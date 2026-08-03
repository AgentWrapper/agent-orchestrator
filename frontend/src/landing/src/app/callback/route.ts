import { handleAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

const appBaseURL = process.env.NEXT_PUBLIC_WEB_URL;

export const GET = handleAuth({
  baseURL: appBaseURL,
  returnPathname: "/app",
  onError: ({ request }) => {
    return NextResponse.redirect(new URL("/auth", appBaseURL ?? request.url));
  },
});
