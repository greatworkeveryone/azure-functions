// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sendFeedback — the in-app feedback widget.
//
// Multipart: topic, customTopic, body, url, userAgent, viewport, photo0..photo2.
// The sender's name/email/oid come from the VERIFIED token, never the body —
// the body is user-controlled and would otherwise let anyone sign someone
// else's name to a complaint.
//
// Email-only delivery: no DB row, no blob storage. Photos become inline Graph
// file attachments. See docs/superpowers/specs/2026-08-13-feedback-widget-design.md
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  AppRole,
  errorResponse,
  requireRole,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import {
  buildFeedbackEmail,
  getFeedbackRecipients,
  isFeedbackTopic,
  MAX_CUSTOM_TOPIC_CHARS,
} from "../email/feedback-email";
import { graphSendMail } from "../graph";
import { checkRateLimit } from "../rateLimit";
import { Sentry } from "../sentry";
import { isAllowedContentType } from "../upload-constants";
import type { GraphAttachment } from "../graph";

const MAX_BODY_CHARS = 4000;
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
// Graph caps sendMail request bodies at 4MB and base64 inflates by 4/3, so the
// raw total must stay under ~3MB. Per-photo limits alone multiply past it.
const MAX_TOTAL_PHOTO_BYTES = 2.5 * 1024 * 1024;

function badRequest(error: string): HttpResponseInit {
  return { status: 400, jsonBody: { error } };
}

/** FormData values are `File | string`. Narrow to a trimmed string, defaulting
 *  a missing or file-valued entry to "". */
function readField(form: FormData, key: string): string {
  const entry = form.get(key);
  return typeof entry === "string" ? entry.trim() : "";
}

type PhotoResult =
  | { ok: true; attachments: GraphAttachment[] }
  | { ok: false; error: string };

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

async function collectPhotos(form: FormData): Promise<PhotoResult> {
  // Count and collection must come from the same list — deriving the cap from a
  // single literal key let a client sidestep it with a non-contiguous index.
  const entries: File[] = [];
  for (const [key, value] of Array.from(form.entries())) {
    if (/^photo\d+$/.test(key) && typeof value !== "string") entries.push(value);
  }

  if (entries.length > MAX_PHOTOS) {
    return { ok: false, error: `A maximum of ${MAX_PHOTOS} photos can be attached` };
  }

  // Validate every entry before reading any of them — otherwise a valid first
  // photo is fully buffered only to be discarded when a later one fails.
  let totalBytes = 0;
  for (const entry of entries) {
    // isAllowedContentType covers the general upload allowlist and explicitly
    // excludes image/svg+xml; the startsWith check narrows it to images only.
    if (!entry.type.startsWith("image/") || !isAllowedContentType(entry.type)) {
      return { ok: false, error: "Unsupported image type" };
    }
    if (entry.size > MAX_PHOTO_BYTES) {
      return { ok: false, error: `Each photo must be under ${MAX_PHOTO_BYTES} bytes` };
    }
    totalBytes += entry.size;
  }

  if (totalBytes > MAX_TOTAL_PHOTO_BYTES) {
    return { ok: false, error: "Attached photos are too large in total — attach fewer or smaller images" };
  }

  const attachments: GraphAttachment[] = [];
  for (const entry of entries) {
    const buffer = Buffer.from(await entry.arrayBuffer());
    attachments.push({
      contentBase64: buffer.toString("base64"),
      contentType: entry.type,
      // Generated, never the client's filename — a multipart filename is
      // attacker-controlled and lands unescaped in the reader's mail client
      // (RTLO extension spoofing, CRLF, traversal).
      fileName: `photo-${attachments.length + 1}.${extensionFor(entry.type)}`,
    });
  }

  return { ok: true, attachments };
}

export async function handleSendFeedback(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Baseline gate — any caller holding any role. The hierarchy inside
  // requireRole means superset roles need not be enumerated here.
  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;

  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const gate = checkRateLimit(`sendFeedback:${identity.oid}`, { limit: 5, windowMs: 60_000 });
  if (!gate.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(gate.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  // Parsed on its own so a malformed body is the client's 400, not our 500 —
  // the outer catch routes through errorResponse, which pages Sentry.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest("Request body must be a valid multipart form");
  }

  try {
    const topic = readField(form, "topic");
    if (!isFeedbackTopic(topic)) return badRequest("Unknown topic");

    const body = readField(form, "body");
    if (!body) return badRequest("Feedback body is required");
    // Code points, not UTF-16 units — 41 emoji is 41 characters to the user who
    // typed them, so counting .length would reject them with a false reason.
    if ([...body].length > MAX_BODY_CHARS) {
      return badRequest(`Feedback body must be under ${MAX_BODY_CHARS} characters`);
    }

    const customTopic = readField(form, "customTopic");
    if (topic === "other" && !customTopic) {
      return badRequest("A custom topic is required when the topic is 'other'");
    }
    if ([...customTopic].length > MAX_CUSTOM_TOPIC_CHARS) {
      return badRequest(`Custom topic must be under ${MAX_CUSTOM_TOPIC_CHARS} characters`);
    }

    const photos = await collectPhotos(form);
    if (!photos.ok) return badRequest(photos.error);

    const recipients = getFeedbackRecipients();
    if (recipients.length === 0) {
      return errorResponse(
        "Feedback email is not configured — FEEDBACK_EMAIL_RECIPIENTS is empty",
      );
    }

    const email = buildFeedbackEmail({
      body,
      customTopic: customTopic || null,
      sender: { email: identity.email, name: identity.name },
      sentAt: new Date(),
      topic,
      url: readField(form, "url"),
      userAgent: readField(form, "userAgent"),
      viewport: readField(form, "viewport"),
    });

    try {
      await graphSendMail(recipients, email.subject, email.body, photos.attachments);
    } catch (error) {
      // errorResponse (the usual Sentry path) is bypassed here so the caller
      // gets a 502 rather than a 500 — capture explicitly or a Graph outage
      // shows up nowhere.
      Sentry.captureException(error, { extra: { context: "sendFeedback graphSendMail" } });
      context.error(`Feedback email failed for ${identity.oid}`, error);
      return { status: 502, jsonBody: { error: "Could not send the feedback email" } };
    }

    context.log(`Feedback sent by ${identity.oid} (${topic}, ${photos.attachments.length} photos)`);
    return { status: 200, jsonBody: { sent: true } };
  } catch (error) {
    return errorResponse("Failed to send feedback", error);
  }
}

app.http("sendFeedback", {
  authLevel: "anonymous",
  handler: handleSendFeedback,
  methods: ["POST"],
});
