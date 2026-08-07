import { getSignUpUrl } from "@workos-inc/authkit-nextjs";

import { cloudAppReturnTo } from "@/lib/auth-return-to";
import { workOSRedirectResponse } from "@/lib/workos-redirect-response";

export const GET = async (request: Request) => {
  const returnTo = cloudAppReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  return workOSRedirectResponse(await getSignUpUrl({ returnTo }));
};
