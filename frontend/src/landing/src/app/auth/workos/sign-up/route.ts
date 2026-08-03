import { getSignUpUrl } from "@workos-inc/authkit-nextjs";

import { workOSRedirectResponse } from "@/lib/workos-redirect-response";

export const GET = async () => {
  return workOSRedirectResponse(await getSignUpUrl({ returnTo: "/app" }));
};
