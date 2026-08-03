import { getSignInUrl } from "@workos-inc/authkit-nextjs";

import { workOSRedirectResponse } from "@/lib/workos-redirect-response";

export const GET = async () => {
  return workOSRedirectResponse(await getSignInUrl({ returnTo: "/app" }));
};
