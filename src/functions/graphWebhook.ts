import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, createServiceConnection, executeQuery, closeConnection } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { graphFetchEmails, graphCreateSubscription, graphRenewSubscription } from "../graph";
import { upsertGraphEmails } from "./emails";
import { runParseBatch } from "./parseEmails";

// ── POST /api/graphNotification ─────────────────────────────────────────────
// Receives Graph change notifications when new email arrives in the mailbox.
// Also handles the one-time validation POST that Graph sends when a
// subscription is first created (validationToken in query params).

async function graphNotification(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  // Subscription validation handshake — must echo validationToken as plain text
  const validationToken = new URL(request.url).searchParams.get("validationToken");
  if (validationToken) {
    return { status: 200, headers: { "Content-Type": "text/plain" }, body: validationToken };
  }

  interface GraphChangeNotification { clientState?: string; subscriptionId?: string; changeType?: string; resource?: string }
  const body = (await request.json().catch(() => null)) as { value?: GraphChangeNotification[] } | null;
  const notifications: GraphChangeNotification[] = body?.value ?? [];
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  const valid = notifications.filter(
    (n) => !clientState || n.clientState === clientState,
  );

  if (valid.length === 0) {
    context.warn("graphNotification: no valid notifications (clientState mismatch?)");
    return { status: 202 };
  }

  const mailbox = process.env.GRAPH_MAILBOX_DEV;
  if (!mailbox) {
    context.error("graphNotification: GRAPH_MAILBOX_DEV not configured");
    return { status: 202 };
  }

  const parseToken = process.env.MYBUILDINGS_BEARER_TOKEN;
  if (!parseToken) {
    context.error("graphNotification: MYBUILDINGS_BEARER_TOKEN not configured");
    return { status: 202 };
  }

  let connection;
  try {
    connection = await createServiceConnection();
    const latestRows = await executeQuery(connection, "SELECT MAX(ReceivedAt) AS LatestReceivedAt FROM Emails");
    const rawDate = latestRows[0]?.LatestReceivedAt as Date | string | null;
    const sinceDateTime = rawDate ? new Date(rawDate).toISOString() : undefined;

    const emails = await graphFetchEmails(mailbox, sinceDateTime);
    await upsertGraphEmails(connection, emails);
    closeConnection(connection);
    connection = undefined;

    await runParseBatch(parseToken, context);
    context.log(`graphNotification: synced ${emails.length} emails from ${mailbox} (since=${sinceDateTime ?? "beginning"})`);
  } catch (err: any) {
    context.error("graphNotification sync failed:", err.message);
  } finally {
    if (connection) closeConnection(connection);
  }

  // Graph requires 202 within 10 seconds or it retries
  return { status: 202 };
}

// ── POST /api/setupGraphSubscription ────────────────────────────────────────
// One-time call (or re-run to replace an existing subscription) after deploy.
// Requires GRAPH_NOTIFICATION_URL and GRAPH_SUBSCRIPTION_CLIENT_STATE to be set.

async function setupGraphSubscription(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const mailbox = process.env.GRAPH_MAILBOX_DEV;
  const notificationUrl = process.env.GRAPH_NOTIFICATION_URL;
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  if (!mailbox || !notificationUrl || !clientState) {
    return {
      status: 500,
      jsonBody: {
        error: "GRAPH_MAILBOX_DEV, GRAPH_NOTIFICATION_URL, and GRAPH_SUBSCRIPTION_CLIENT_STATE must all be set",
      },
    };
  }

  let connection;
  try {
    const { subscriptionId, expiresAt } = await graphCreateSubscription(
      mailbox,
      notificationUrl,
      clientState,
    );

    connection = await createConnection(token);
    await executeQuery(
      connection,
      `MERGE GraphSubscriptions AS target
       USING (SELECT @Mailbox AS Mailbox) AS src ON target.Mailbox = src.Mailbox
       WHEN MATCHED THEN
         UPDATE SET SubscriptionID = @SubscriptionID, ExpiresAt = @ExpiresAt
       WHEN NOT MATCHED THEN
         INSERT (SubscriptionID, Mailbox, ExpiresAt) VALUES (@SubscriptionID, @Mailbox, @ExpiresAt);`,
      [
        { name: "SubscriptionID", type: TYPES.NVarChar, value: subscriptionId },
        { name: "Mailbox", type: TYPES.NVarChar, value: mailbox },
        { name: "ExpiresAt", type: TYPES.NVarChar, value: expiresAt },
      ],
    );

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
// Self-heals: if no subscription row exists it creates a new one.

async function renewGraphSubscription(
  _myTimer: unknown,
  context: InvocationContext,
): Promise<void> {
  const mailbox = process.env.GRAPH_MAILBOX_DEV;
  const notificationUrl = process.env.GRAPH_NOTIFICATION_URL;
  const clientState = process.env.GRAPH_SUBSCRIPTION_CLIENT_STATE;

  if (!mailbox || !notificationUrl || !clientState) {
    context.error("renewGraphSubscription: env vars not configured");
    return;
  }

  let connection;
  try {
    connection = await createServiceConnection();

    const rows = await executeQuery(
      connection,
      `SELECT SubscriptionID FROM GraphSubscriptions WHERE Mailbox = @Mailbox`,
      [{ name: "Mailbox", type: TYPES.NVarChar, value: mailbox }],
    );

    if (!rows[0]) {
      // No subscription — create one (e.g. after a fresh deploy)
      const { subscriptionId, expiresAt } = await graphCreateSubscription(
        mailbox,
        notificationUrl,
        clientState,
      );
      await executeQuery(
        connection,
        `INSERT INTO GraphSubscriptions (SubscriptionID, Mailbox, ExpiresAt) VALUES (@SubscriptionID, @Mailbox, @ExpiresAt)`,
        [
          { name: "SubscriptionID", type: TYPES.NVarChar, value: subscriptionId },
          { name: "Mailbox", type: TYPES.NVarChar, value: mailbox },
          { name: "ExpiresAt", type: TYPES.NVarChar, value: expiresAt },
        ],
      );
      context.log(`renewGraphSubscription: no subscription found, created ${subscriptionId}`);
      return;
    }

    const subscriptionId = rows[0].SubscriptionID as string;
    const newExpiresAt = await graphRenewSubscription(subscriptionId);

    await executeQuery(
      connection,
      `UPDATE GraphSubscriptions SET ExpiresAt = @ExpiresAt WHERE SubscriptionID = @SubscriptionID`,
      [
        { name: "ExpiresAt", type: TYPES.NVarChar, value: newExpiresAt },
        { name: "SubscriptionID", type: TYPES.NVarChar, value: subscriptionId },
      ],
    );

    context.log(`renewGraphSubscription: renewed ${subscriptionId}, expires ${newExpiresAt}`);
  } catch (err: any) {
    context.error("renewGraphSubscription failed:", err.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("graphNotification", {
  methods: ["POST"],
  authLevel: "anonymous",
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
  handler: renewGraphSubscription,
});
