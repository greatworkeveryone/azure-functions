import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createHash, timingSafeEqual } from "crypto";
import { TYPES, type Connection } from "tedious";
import { createRequestConnection, createServiceRequestConnection, executeQuery, closeConnection } from "../db";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { graphCreateSubscription, graphRenewSubscription } from "../graph";
import { emailSyncQueueOutput, enqueueEmailSync } from "../email/sync-queue";
import { incomingMailbox, mailboxConfigError } from "../email/mailbox";
import { readInboundConfig } from "../inboundTriage/config";
import { checkRateLimit } from "../rateLimit";
import { runTimer } from "../timerRuns";

/** Constant-time string compare. Returns false on length mismatch instead of
 *  leaking timing information about the prefix. */
function timingSafeCompareString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ── POST /api/graphNotification ─────────────────────────────────────────────
// Receives Graph change notifications when new email arrives in the mailbox.
// Also handles the one-time validation POST that Graph sends when a
// subscription is first created (validationToken in query params).
//
// Validate and enqueue only — no Graph fetch, no attachment download, no
// parsing. processEmailSync (parseEmails.ts) does all of that off the
// "email-sync" queue.

export async function graphNotification(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Subscription validation handshake — must echo validationToken as plain text
  const validationToken = new URL(request.url).searchParams.get("validationToken");
  if (validationToken) {
    return { status: 200, headers: { "Content-Type": "text/plain" }, body: validationToken };
  }

  interface GraphChangeNotification { clientState?: string; subscriptionId?: string; changeType?: string; resource?: string }
  const body = (await request.json().catch(() => null)) as { value?: unknown } | null;
  const rawValue: unknown = body?.value;
  // Entries are untrusted JSON: keep only non-null objects.
  const notifications: GraphChangeNotification[] = (Array.isArray(rawValue) ? rawValue : []).filter(
    (n: unknown): n is GraphChangeNotification => typeof n === "object" && n !== null,
  );
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;
  if (!clientState) {
    context.error("graphNotification: GRAPH_SUBSCRIPTION_CLIENT_STATE is not configured — rejecting all notifications");
    return { status: 202 };
  }
  if (notifications.length === 0) {
    context.warn("graphNotification: no notifications in body (malformed or empty)");
    return { status: 202 };
  }

  const valid = notifications.filter((n) =>
    typeof n.clientState === "string" && timingSafeCompareString(n.clientState, clientState),
  );

  if (valid.length === 0) {
    context.warn("graphNotification: no valid notifications (clientState mismatch)");
    return { status: 202 };
  }

  // One message per POST however many notifications it carries — the sync
  // fetches everything since the newest stored row anyway.
  enqueueEmailSync(context, "graph");

  // Graph wants the 202 within 3 s (10 s only for validation and retries);
  // slower than that on >10% of calls in 10 min and it marks the endpoint
  // slow and delays notifications by 10 minutes.
  return { status: 202 };
}

// ── GraphSubscriptions (migration 123) ───────────────────────────────────────
// One row per mailbox (unique). ClientStateHash is SHA-256 of the client state
// the subscription was created with, so a rotated secret shows up as a stale
// row; the secret itself is never stored.

interface NewSubscription {
  expiresAt: string;
  resource: string;
  subscriptionId: string;
}

async function storeSubscription(
  connection: Connection,
  mailbox: string,
  clientState: string,
  sub: NewSubscription,
): Promise<void> {
  await executeQuery(
    connection,
    `MERGE dbo.GraphSubscriptions WITH (HOLDLOCK) AS target
     USING (SELECT @Mailbox AS Mailbox) AS src ON target.Mailbox = src.Mailbox
     WHEN MATCHED THEN
       UPDATE SET SubscriptionID = @SubscriptionID, ExpiresAt = @ExpiresAt, Resource = @Resource,
                  ClientStateHash = @ClientStateHash
     WHEN NOT MATCHED THEN
       INSERT (SubscriptionID, Mailbox, Resource, ExpiresAt, ClientStateHash)
       VALUES (@SubscriptionID, @Mailbox, @Resource, @ExpiresAt, @ClientStateHash);`,
    [
      { name: "SubscriptionID", type: TYPES.NVarChar, value: sub.subscriptionId },
      { name: "Mailbox", type: TYPES.NVarChar, value: mailbox },
      { name: "Resource", type: TYPES.NVarChar, value: sub.resource },
      { name: "ExpiresAt", type: TYPES.DateTime2, value: new Date(sub.expiresAt) },
      { name: "ClientStateHash", type: TYPES.NVarChar, value: createHash("sha256").update(clientState).digest("hex") },
    ],
  );
}

// ── POST /api/setupGraphSubscription ────────────────────────────────────────
// One-time call (or re-run to replace an existing subscription) after deploy.
// Requires GRAPH_NOTIFICATION_URL and GRAPH_SUBSCRIPTION_CLIENT_STATE to be set.

export async function setupGraphSubscription(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.ADMIN]);
  if (denied) return denied;

  const callerOid = oidFromToken(token) ?? "unknown";
  const rl = checkRateLimit(`setupGraphSubscription:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const mailbox = incomingMailbox();
  const notificationUrl = process.env.GRAPH_NOTIFICATION_URL;
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  if (!mailbox || !notificationUrl || !clientState) {
    return {
      status: 500,
      jsonBody: {
        error: mailbox
          ? "GRAPH_NOTIFICATION_URL and GRAPH_SUBSCRIPTION_CLIENT_STATE must both be set"
          : mailboxConfigError(),
      },
    };
  }

  let connection;
  try {
    const created = await graphCreateSubscription(mailbox, notificationUrl, clientState);
    const { subscriptionId, expiresAt } = created;

    connection = await createRequestConnection(token);
    await storeSubscription(connection, mailbox, clientState, created);

    context.log(`Subscription created: ${subscriptionId}, expires: ${expiresAt}`);
    return { status: 200, jsonBody: { subscriptionId, expiresAt } };
  } catch (err: any) {
    return errorResponse("Setup failed", err.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── Timer: renewGraphSubscription ───────────────────────────────────────────
// Runs daily to renew the subscription before its 3-day expiry.
// Self-heals: if no subscription row exists it creates a new one, and if Graph
// no longer knows the stored one (404: it expired or was deleted) it creates a
// replacement. Any other failure throws, so runTimer records it (DL-12/13).

// Renews or creates the subscription for one mailbox.
async function renewMailboxSubscription(
  conn: Connection,
  mailbox: string,
  notificationUrl: string,
  clientState: string,
  context: InvocationContext,
): Promise<void> {
  const rows = await executeQuery(
    conn,
    `SELECT SubscriptionID FROM dbo.GraphSubscriptions WHERE Mailbox = @Mailbox`,
    [{ name: "Mailbox", type: TYPES.NVarChar, value: mailbox }],
  );

  const replace = async (why: string) => {
    const created = await graphCreateSubscription(mailbox, notificationUrl, clientState);
    await storeSubscription(conn, mailbox, clientState, created);
    context.log(`renewGraphSubscription: ${why}, created ${created.subscriptionId}`);
  };

  if (!rows[0]) {
    await replace("no subscription found");
    return;
  }

  const subscriptionId = rows[0].SubscriptionID as string;
  let newExpiresAt: string;
  try {
    newExpiresAt = await graphRenewSubscription(subscriptionId);
  } catch (err: unknown) {
    if ((err as { status?: unknown } | null)?.status !== 404) throw err;
    await replace(`Graph no longer has ${subscriptionId}`);
    return;
  }

  await executeQuery(
    conn,
    `UPDATE dbo.GraphSubscriptions SET ExpiresAt = @ExpiresAt WHERE SubscriptionID = @SubscriptionID`,
    [
      { name: "ExpiresAt", type: TYPES.DateTime2, value: new Date(newExpiresAt) },
      { name: "SubscriptionID", type: TYPES.NVarChar, value: subscriptionId },
    ],
  );

  context.log(`renewGraphSubscription: renewed ${subscriptionId}, expires ${newExpiresAt}`);
}

export async function renewGraphSubscription(
  _myTimer: unknown,
  context: InvocationContext,
): Promise<void> {
  const mailbox = incomingMailbox();
  const notificationUrl = process.env.GRAPH_NOTIFICATION_URL;
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  if (!mailbox || !notificationUrl || !clientState) {
    throw new Error(
      "renewGraphSubscription: GRAPH_MAILBOX_DEV, GRAPH_NOTIFICATION_URL and GRAPH_SUBSCRIPTION_CLIENT_STATE must all be set (or disable this timer)",
    );
  }

  let connection: Connection | undefined;
  try {
    // A fresh connection, not the shared singleton (DL-28).
    const conn = await createServiceRequestConnection();
    connection = conn;

    await renewMailboxSubscription(conn, mailbox, notificationUrl, clientState, context);

    // EB3: each extra mailbox (INBOUND_EXTRA_MAILBOXES, empty by default) gets its own subscription so its mail
    // arrives as promptly as the main one's. One that fails does not stop the others; the run still ends in error.
    const failed: string[] = [];
    for (const extra of readInboundConfig().extraMailboxes) {
      try {
        await renewMailboxSubscription(conn, extra, notificationUrl, clientState, context);
      } catch (err: any) {
        failed.push(extra);
        context.error(`renewGraphSubscription: ${extra} failed:`, err.message);
      }
    }
    if (failed.length > 0) throw new Error(`renewGraphSubscription: could not renew the subscription for ${failed.join(", ")}`);
  } catch (err: any) {
    context.error("renewGraphSubscription failed:", err.message);
    throw err;
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("graphNotification", {
  methods: ["POST"],
  authLevel: "anonymous",
  extraOutputs: [emailSyncQueueOutput],
  handler: graphNotification,
});

app.http("setupGraphSubscription", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: setupGraphSubscription,
});

// Daily at 02:00 UTC
app.timer("renewGraphSubscription", {
  schedule: "0 0 2 * * *",
  handler: runTimer("renewGraphSubscription", renewGraphSubscription),
});
