const appOrigin = "https://ao.local";

export function cloudAppReturnTo(value?: string | null): string {
  if (!value) return "/app";
  try {
    const url = new URL(value, appOrigin);
    if (
      url.origin !== appOrigin ||
      (url.pathname !== "/app" && url.pathname !== "/app/")
    ) {
      return "/app";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/app";
  }
}
