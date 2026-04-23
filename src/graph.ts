// Minimal Microsoft Graph API client using client-credentials (app-level) auth.
// Required Azure App Settings / env vars:
//   GRAPH_TENANT_ID      — Azure AD tenant GUID
//   GRAPH_CLIENT_ID      — App registration client ID
//   GRAPH_CLIENT_SECRET  — App registration client secret
//   GRAPH_SENDER_EMAIL   — Mailbox to send from (e.g. floorplan-dev@randazzo.properties)
//
// If any credential is absent, graphSendReply throws — callers should catch
// and record the error rather than blocking the DB write.

interface TokenResponse {
  access_token: string;
}

async function getGraphToken(): Promise<string> {
  const { GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET } = process.env;
  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error(
      "Graph credentials not configured (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET)",
    );
  }

  const url = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: GRAPH_CLIENT_ID,
    client_secret: GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph token request failed: ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;
  return data.access_token;
}

/**
 * Send an outbound email reply via Microsoft Graph sendMail.
 * Sets In-Reply-To / References headers when `inReplyToMessageId` is provided
 * so the message threads correctly in most clients.
 *
 * Returns the Graph internet message ID on success.
 * Throws on any failure — callers should catch and store the error text.
 */
export interface GraphAttachment {
  fileName: string;
  contentType: string;
  contentBase64: string;
}

export async function graphSendReply(
  toAddress: string,
  replySubject: string,
  body: string,
  inReplyToMessageId: string | null,
  attachments?: GraphAttachment[],
  ccAddresses?: string[],
): Promise<string> {
  const token = await getGraphToken();
  const senderEmail = process.env.GRAPH_SENDER_EMAIL;
  if (!senderEmail) {
    throw new Error("GRAPH_SENDER_EMAIL not configured");
  }

  const subject = replySubject.startsWith("Re:") ? replySubject : `Re: ${replySubject}`;

  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: [{ emailAddress: { address: toAddress } }],
  };

  if (ccAddresses?.length) {
    message.ccRecipients = ccAddresses.map((a) => ({ emailAddress: { address: a } }));
  }

  if (inReplyToMessageId) {
    message.internetMessageHeaders = [
      { name: "In-Reply-To", value: inReplyToMessageId },
      { name: "References", value: inReplyToMessageId },
    ];
  }

  if (attachments?.length) {
    message.attachments = attachments.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.fileName,
      contentType: a.contentType,
      contentBytes: a.contentBase64,
    }));
  }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph sendMail failed: ${resp.status} — ${text}`);
  }

  // sendMail returns 202 with no body — synthesise a stable identifier
  return `graph-sent-${Date.now()}`;
}

export async function graphCreateSubscription(
  mailbox: string,
  notificationUrl: string,
  clientState: string,
): Promise<{ subscriptionId: string; expiresAt: string }> {
  const token = await getGraphToken();
  // Mail subscriptions max out at 4230 minutes (~3 days)
  const expiresAt = new Date(Date.now() + 4230 * 60 * 1000).toISOString();

  const resp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource: `users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages`,
      expirationDateTime: expiresAt,
      clientState,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph createSubscription failed: ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as { id: string; expirationDateTime: string };
  return { subscriptionId: data.id, expiresAt: data.expirationDateTime };
}

export async function graphRenewSubscription(subscriptionId: string): Promise<string> {
  const token = await getGraphToken();
  const expiresAt = new Date(Date.now() + 4230 * 60 * 1000).toISOString();

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expirationDateTime: expiresAt }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph renewSubscription failed: ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as { expirationDateTime: string };
  return data.expirationDateTime;
}

export interface GraphEmail {
  internetMessageId: string;
  subject: string | null;
  fromAddress: string | null;
  bodyContent: string | null;
  receivedAt: string | null;
}

export async function graphFetchEmails(mailbox: string): Promise<GraphEmail[]> {
  const token = await getGraphToken();

  const url = new URL(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages`,
  );
  url.searchParams.set("$select", "internetMessageId,subject,from,body,receivedDateTime");
  url.searchParams.set("$filter", "isRead eq false");
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$top", "50");

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph fetch emails failed: ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as { value: any[] };
  return (data.value ?? []).map((m) => ({
    internetMessageId: m.internetMessageId ?? m.id,
    subject: m.subject ?? null,
    fromAddress: m.from?.emailAddress?.address ?? null,
    bodyContent: m.body?.content ?? null,
    receivedAt: m.receivedDateTime ?? null,
  }));
}
