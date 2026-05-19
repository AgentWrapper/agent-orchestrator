import { NextResponse } from "next/server";
import { recordActivityEvent } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import {
  buildWebhookRequest,
  eventMatchesProject,
  findAffectedSessions,
  findWebhookProjects,
} from "@/lib/scm-webhooks";

export const dynamic = "force-dynamic";

const WEBHOOK_PATH_PREFIX = "/api/webhooks/";

function deriveSlug(pathname: string): string {
  return pathname.startsWith(WEBHOOK_PATH_PREFIX)
    ? pathname.slice(WEBHOOK_PATH_PREFIX.length)
    : pathname;
}

function deriveRemoteAddr(request: Request): string | undefined {
  // Next.js does not expose the socket peer address on Request. The standard
  // proxy headers are the only signal — first hop in x-forwarded-for is the
  // original client. Sanitizer in recordActivityEvent does not redact IPs;
  // they are intentionally retained for security audit (per issue #1656).
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? undefined;
}

export async function POST(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const slug = deriveSlug(pathname);
  const remoteAddr = deriveRemoteAddr(request);

  try {
    const services = await getServices();
    const candidates = findWebhookProjects(services.config, services.registry, pathname);

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "No SCM webhook configured for this path" },
        { status: 404 },
      );
    }

    const rawContentLength = request.headers.get("content-length");
    const contentLength = rawContentLength ? Number(rawContentLength) : NaN;
    const candidateMaxBodyBytes = candidates.map(
      (candidate) => candidate.project.scm?.webhook?.maxBodyBytes,
    );
    const allCandidatesBounded = candidateMaxBodyBytes.every((value) => typeof value === "number");
    const maxBodyBytes = allCandidatesBounded
      ? Math.max(...(candidateMaxBodyBytes as number[]))
      : undefined;
    if (
      maxBodyBytes !== undefined &&
      Number.isFinite(contentLength) &&
      contentLength > maxBodyBytes
    ) {
      recordActivityEvent({
        source: "api",
        kind: "api.webhook_rejected",
        level: "warn",
        summary: `webhook payload exceeded ${maxBodyBytes} bytes for ${slug}`,
        data: {
          slug,
          remoteAddr,
          contentLength,
          maxBodyBytes,
          reason: "payload_too_large",
        },
      });
      return NextResponse.json(
        { error: "Webhook payload exceeds configured maxBodyBytes" },
        { status: 413 },
      );
    }

    const rawBody = new Uint8Array(await request.arrayBuffer());
    const body = new TextDecoder().decode(rawBody);
    const webhookRequest = buildWebhookRequest(request, body, rawBody);

    const sessions = await services.sessionManager.list();
    const sessionIds = new Set<string>();
    const projectIds = new Set<string>();
    let verified = false;
    let verificationSupported = false;
    let unsupportedVerificationCount = 0;
    const errors: string[] = [];
    const parseErrors: string[] = [];
    const lifecycleErrors: string[] = [];

    for (const candidate of candidates) {
      if (!candidate.scm.verifyWebhook) {
        unsupportedVerificationCount += 1;
        errors.push("Webhook verification not supported by SCM plugin");
        continue;
      }

      verificationSupported = true;
      const verification = await candidate.scm.verifyWebhook(webhookRequest, candidate.project);
      if (!verification?.ok) {
        if (verification?.reason) errors.push(verification.reason);
        continue;
      }
      verified = true;

      let event;
      try {
        event = await candidate.scm.parseWebhook?.(webhookRequest, candidate.project);
      } catch (err) {
        parseErrors.push(err instanceof Error ? err.message : "Invalid webhook payload");
        continue;
      }

      if (!event || !eventMatchesProject(event, candidate.project)) {
        continue;
      }

      projectIds.add(candidate.projectId);
      const affectedSessions = findAffectedSessions(sessions, candidate.projectId, event);
      if (affectedSessions.length === 0) {
        continue;
      }

      const lifecycle = services.lifecycleManager;
      for (const session of affectedSessions) {
        sessionIds.add(session.id);
        try {
          await lifecycle.check(session.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Lifecycle check failed";
          lifecycleErrors.push(`session ${session.id}: ${message}`);
        }
      }
    }

    if (!verified) {
      const unsupportedOnly = !verificationSupported && unsupportedVerificationCount > 0;
      recordActivityEvent({
        source: "api",
        kind: "api.webhook_unverified",
        level: "warn",
        summary: unsupportedOnly
          ? `webhook verification unsupported for ${slug}`
          : `webhook signature verification failed for ${slug}`,
        data: {
          slug,
          remoteAddr,
          candidateCount: candidates.length,
          verificationSupported,
          unsupportedVerificationCount,
          reason: unsupportedOnly
            ? "verification_unsupported"
            : (errors[0] ?? "verification_failed"),
        },
      });
      return NextResponse.json(
        {
          error: unsupportedOnly
            ? "No SCM webhook configured for this path"
            : (errors[0] ?? "Webhook verification failed"),
          ok: false,
          verificationSupported,
        },
        { status: unsupportedOnly ? 404 : 401 },
      );
    }

    recordActivityEvent({
      source: "api",
      kind: "api.webhook_received",
      level: parseErrors.length > 0 || lifecycleErrors.length > 0 ? "warn" : "info",
      summary: `webhook accepted for ${slug}: ${sessionIds.size} session(s) matched`,
      data: {
        slug,
        remoteAddr,
        projectIds: [...projectIds],
        matchedSessions: sessionIds.size,
        parseErrorCount: parseErrors.length,
        lifecycleErrorCount: lifecycleErrors.length,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        projectIds: [...projectIds],
        sessionIds: [...sessionIds],
        matchedSessions: sessionIds.size,
        parseErrors,
        lifecycleErrors,
      },
      { status: 202 },
    );
  } catch (err) {
    recordActivityEvent({
      source: "api",
      kind: "api.webhook_failed",
      level: "error",
      summary: `webhook pipeline crashed for ${slug}`,
      data: {
        slug,
        remoteAddr,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process SCM webhook" },
      { status: 500 },
    );
  }
}
