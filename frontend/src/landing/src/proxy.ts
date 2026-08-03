import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default authkitMiddleware({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/auth", "/auth/workos/sign-in", "/auth/workos/sign-up"],
  },
  signUpPaths: ["/auth/workos/sign-up"],
});

export const config = {
  matcher: ["/app/:path*", "/api/cloud-auth/:path*", "/callback"],
};
