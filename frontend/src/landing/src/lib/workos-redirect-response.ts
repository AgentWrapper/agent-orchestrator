function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function workOSRedirectResponse(authURL: string) {
  const escapedURL = escapeHTML(authURL);
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0;url=${escapedURL}">
    <meta name="referrer" content="no-referrer">
    <title>Continue to sign in</title>
  </head>
  <body>
    <p>Redirecting to sign in…</p>
    <p><a href="${escapedURL}" rel="noreferrer">Continue</a></p>
  </body>
</html>`;

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    },
  });
}
