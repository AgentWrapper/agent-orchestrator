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
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#08090b">
    <title>Continue to Cloud</title>
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        display: grid;
        min-height: 100vh;
        place-items: center;
        overflow: hidden;
        background: #08090b;
        color: #f4f5f7;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        justify-items: center;
        gap: 24px;
        padding: 32px;
        text-align: center;
      }
      .glyph {
        position: relative;
        display: grid;
        width: 80px;
        height: 80px;
        place-items: center;
      }
      .glyph::before,
      .glyph::after {
        position: absolute;
        content: "";
        border-radius: 999px;
      }
      .glyph::before {
        inset: 0;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-top-color: #4d8dff;
        animation: spin 900ms linear infinite;
      }
      .glyph::after {
        inset: 9px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .glyph img {
        position: relative;
        z-index: 1;
        width: 42px;
        height: 42px;
        border-radius: 10px;
      }
      .label {
        margin: 0;
        color: rgba(244, 245, 247, 0.58);
        font-size: 13px;
        line-height: 20px;
      }
      .fallback {
        color: rgba(244, 245, 247, 0.32);
        font-size: 11px;
        text-underline-offset: 3px;
      }
      .fallback:hover { color: rgba(244, 245, 247, 0.72); }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .glyph::before { animation: none; }
      }
    </style>
  </head>
  <body>
    <main role="status" aria-live="polite">
      <div class="glyph" aria-hidden="true">
        <img src="/ao-logo.svg" alt="">
      </div>
      <p class="label">Opening secure sign-in…</p>
      <a class="fallback" href="${escapedURL}" rel="noreferrer">Continue manually</a>
    </main>
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
