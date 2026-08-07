/**
 * Session replay, scoped to the design-partner page and nothing else.
 *
 * The init config keeps `disable_session_recording: true` permanently, so replay
 * is never armed by configuration. Recording is started by an explicit call from
 * a component that only exists on this one route, which means the blast radius
 * is the route rather than the project.
 */

/**
 * The desktop app's PostHog project key.
 *
 * Duplicated here deliberately. The marketing site and the desktop app currently
 * point at the same project, and arming replay on that project would start
 * recording the screens of installs already in the field, including builds old
 * enough to predate the client-side block. So recording refuses to start while
 * the configured key is this one, and moving the site to its own project is what
 * unlocks it.
 *
 * This is a public project key. It ships in every client bundle by design and is
 * not a credential.
 */
export const DESKTOP_PROJECT_KEY = "phc_uXAqS8nokL2QLSGBZSEMHTUNVXsFeXu3SrcWG7fjEyVH";

/** The only path permitted to record. */
export const REPLAY_PATH = "/design-partners";

export type ReplayDecision =
  | { record: true }
  | { record: false; reason: "no-key" | "shared-project" | "wrong-path" | "not-consented" };

/**
 * Decides whether this page load may record.
 *
 * Every condition must hold. Split out from the component so the refusals are
 * testable without a browser, because the interesting cases are the ones where
 * it must say no.
 */
export function replayDecision(input: {
  key: string | undefined;
  pathname: string;
  optedOut: boolean;
}): ReplayDecision {
  const key = input.key?.trim() ?? "";
  if (!key) return { record: false, reason: "no-key" };
  if (key === DESKTOP_PROJECT_KEY) return { record: false, reason: "shared-project" };

  const path = input.pathname.replace(/\/+$/, "") || "/";
  if (path !== REPLAY_PATH && !path.startsWith(`${REPLAY_PATH}/`)) {
    return { record: false, reason: "wrong-path" };
  }
  // Recording someone who declined analytics would be worse than not recording
  // at all, so consent is checked last and is not negotiable.
  if (input.optedOut) return { record: false, reason: "not-consented" };

  return { record: true };
}
