import { handleAuth } from "@workos-inc/authkit-nextjs";

export const GET = handleAuth({ returnPathname: "/app" });
