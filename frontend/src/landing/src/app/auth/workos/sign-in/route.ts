import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";

export const GET = async () => {
  redirect(await getSignInUrl({ returnTo: "/app" }));
};
