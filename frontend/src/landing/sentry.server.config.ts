import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN_MARKETING,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  enabled: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT === "production",
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  debug: false,
});
