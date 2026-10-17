// Minimal Microsoft Graph API client using client-credentials (app-level) auth.
// Required Azure App Settings / env vars:
//   GRAPH_TENANT_ID      — Azure AD tenant GUID
//   GRAPH_CLIENT_ID      — App registration client ID
//   GRAPH_CLIENT_SECRET  — App registration client secret
//   GRAPH_SENDER_EMAIL   — Mailbox to send from (e.g. floorplan-dev@randazzo.properties)
//
//   ORG_EMAIL_DOMAINS    — tenant's accepted domains, for sender auth (src/email/sender-auth.ts)
//
// If any credential is absent, graphSendReply throws — callers should catch
// and record the error rather than blocking the DB write.

import { assessSenderAuth, type MessageHeader } from "./email/sender-auth";

interface TokenResponse {
  access_token: string;
}

export async function getGraphToken(): Promise<string> {
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

export async function graphSendMail(
  toAddress: string | string[],
  subject: string,
  body: string,
  attachments?: GraphAttachment[],
  ccAddresses?: string[],
): Promise<void> {
  const token = await getGraphToken();
  const senderEmail = process.env.GRAPH_SENDER_EMAIL;
  if (!senderEmail) {
    throw new Error("GRAPH_SENDER_EMAIL not configured");
  }

  const recipients = Array.isArray(toAddress) ? toAddress : [toAddress];
  const message: Record<string, unknown> = {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: recipients.map((a) => ({ emailAddress: { address: a } })),
  };

  if (ccAddresses?.length) {
    message.ccRecipients = ccAddresses.map((a) => ({ emailAddress: { address: a } }));
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
}

export async function graphCreateSubscription(
  mailbox: string,
  notificationUrl: string,
  clientState: string,
): Promise<{ subscriptionId: string; expiresAt: string; resource: string }> {
  const token = await getGraphToken();
  // Mail subscriptions max out at 4230 minutes (~3 days)
  const expiresAt = new Date(Date.now() + 4230 * 60 * 1000).toISOString();

  const resource = `users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages`;

  const resp = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource,
      expirationDateTime: expiresAt,
      clientState,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph createSubscription failed: ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as { id: string; expirationDateTime: string };
  return { subscriptionId: data.id, expiresAt: data.expirationDateTime, resource };
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
    // status lets the renew timer replace a subscription Graph has dropped (404).
    throw Object.assign(new Error(`Graph renewSubscription failed: ${resp.status} — ${text}`), { status: resp.status });
  }

  const data = (await resp.json()) as { expirationDateTime: string };
  return data.expirationDateTime;
}

export interface GraphEmail {
  attachmentBlobNames: { blobName: string; fileName: string }[];
  // Trimmed auth headers for audit / the approval UI (≤ 2000 chars).
  authenticationResults: string | null;
  graphMessageId: string;
  internetMessageId: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  bodyContent: string | null;
  receivedAt: string | null;
  // DMARC pass aligned with From, or Exchange-authenticated internal sender.
  senderAuthenticated: boolean;
}

function toMessageHeaders(raw: unknown): MessageHeader[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is MessageHeader =>
      typeof h === "object" && h !== null && typeof h.name === "string" && typeof h.value === "string",
  );
}

// Graph throttles (429) and has bad moments (5xx, dropped connections); one
// more try after a short pause saves an attachment that would otherwise be
// stored without its file (DL-13). Anything else is answered as it came.
const RETRY_DELAY_MS = 300;
const isTransient = (status: number) => status === 408 || status === 429 || status >= 500;

async function fetchOnceMore(url: string, init: RequestInit): Promise<Response> {
  try {
    const resp = await fetch(url, init);
    if (!isTransient(resp.status)) return resp;
  } catch {
    // network failure: fall through to the second attempt
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return fetch(url, init);
}

async function fetchAttachmentBytes(
  mailbox: string,
  graphMessageId: string,
  attachmentId: string,
  token: string,
): Promise<Buffer> {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}/attachments/${attachmentId}/$value`;
  const resp = await fetchOnceMore(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`Graph attachment download failed: ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function fetchAndUploadAttachments(
  mailbox: string,
  graphMessageId: string,
  token: string,
): Promise<{ blobName: string; fileName: string }[]> {
  const { uploadBlob } = await import("./blob-storage");

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${graphMessageId}/attachments?$select=id,name,contentType,isInline,size`;
  const resp = await fetchOnceMore(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    console.error(`[attachments] Graph list failed for msg=${graphMessageId}: ${resp.status} ${await resp.text().catch(() => "")}`);
    return [];
  }

  const data = (await resp.json()) as { value: any[] };
  const all = data.value ?? [];

  // Accept all file attachments that have a name — isInline is unreliable
  // (Outlook often marks image attachments as inline) and contentBytes is
  // absent for attachments >3 MB, so we fall back to a per-attachment fetch.
  const fileAttachments = all.filter(
    (a) => a["@odata.type"] === "#microsoft.graph.fileAttachment" && a.name,
  );
  const results: { blobName: string; fileName: string }[] = [];
  for (const att of fileAttachments) {
    try {
      const buffer = await fetchAttachmentBytes(mailbox, graphMessageId, att.id, token);
      const { blobName } = await uploadBlob(
        buffer,
        att.name,
        att.contentType ?? "application/octet-stream",
        // Graph ids are URL-safe base64; map the two standard-base64 characters
        // anyway so the folder always fits EMAIL_ATTACHMENT_SHAPE (blob-names.ts).
        `email-attachments/${graphMessageId.replace(/\+/g, "-").replace(/\//g, "_")}`,
      );
      results.push({ blobName, fileName: att.name });
    } catch (err: any) {
      console.error(`[attachments] failed to upload ${att.name} for msg=${graphMessageId}: ${err?.message}`);
    }
  }
  return results;
}

export interface GraphEmailPage {
  /** Messages on this page not already stored, oldest first. */
  emails: GraphEmail[];
  /** The newest message on the page, stored before or not: where the
   *  watermark may move once this page is stored. */
  newestMessageId: string | null;
  newestReceivedAt: string | null;
}

async function toGraphEmail(m: any, mailbox: string, token: string): Promise<GraphEmail> {
  const attachmentBlobNames =
    m.hasAttachments && m.id
      ? await fetchAndUploadAttachments(mailbox, m.id, token).catch((err: any) => {
          console.error(`[attachments] fetchAndUpload threw for msg=${m.id}: ${err?.message}`);
          return [];
        })
      : [];
  // Graph occasionally returns a `name` that's just the address echoed
  // back; null it out so the UI keeps using the address-only render path
  // for those rather than showing the same string twice.
  const rawName: string | null = m.from?.emailAddress?.name ?? null;
  const rawAddress: string | null = m.from?.emailAddress?.address ?? null;
  const fromName = rawName && rawName !== rawAddress ? rawName : null;
  const auth = assessSenderAuth(toMessageHeaders(m.internetMessageHeaders), rawAddress ?? "");
  return {
    graphMessageId: m.id,
    internetMessageId: m.internetMessageId ?? m.id,
    subject: m.subject ?? null,
    fromAddress: rawAddress,
    fromName,
    bodyContent: m.body?.content ?? null,
    receivedAt: m.receivedDateTime ?? null,
    attachmentBlobNames,
    authenticationResults: auth.summary,
    senderAuthenticated: auth.authenticated,
  };
}

/**
 * The Inbox since `sinceDateTime`, oldest first, one Graph page (50) at a
 * time, following @odata.nextLink to the end (DL-13: newest-first with no
 * paging kept only the newest 50 and skipped the rest for good). The caller
 * stores each page before asking for the next, so a failure leaves every
 * earlier page stored and the later ones still unread.
 */
export async function* graphFetchEmailPages(
  mailbox: string,
  sinceDateTime?: string,
  knownMessageIds: ReadonlySet<string> = new Set(),
): AsyncGenerator<GraphEmailPage> {
  const token = await getGraphToken();

  const url = new URL(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages`,
  );
  // internetMessageHeaders is only returned when $selected; it feeds sender auth.
  url.searchParams.set("$select", "id,internetMessageId,subject,from,body,receivedDateTime,hasAttachments,internetMessageHeaders");
  if (sinceDateTime) {
    url.searchParams.set("$filter", `receivedDateTime ge ${sinceDateTime}`);
  }
  url.searchParams.set("$orderby", "receivedDateTime asc");
  url.searchParams.set("$top", "50");
  const init = {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  };

  let next: string | undefined = url.toString();
  while (next) {
    const resp = await fetchOnceMore(next, init);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Graph fetch emails failed: ${resp.status} — ${text}`);
    }
    const data = (await resp.json()) as { "@odata.nextLink"?: string; value?: any[] };
    const all = data.value ?? [];

    // The `ge` window always re-lists the newest stored message(s). Drop them
    // before their attachments are re-uploaded as orphan blobs. Keyed like
    // upsertGraphEmails keys MessageID.
    const fresh = all.filter((m) => !knownMessageIds.has(m.internetMessageId ?? m.id));
    const newest = all.reduce<any>(
      (latest, m) => (!latest || String(m.receivedDateTime ?? "") >= String(latest.receivedDateTime ?? "") ? m : latest),
      null,
    );
    yield {
      emails: await Promise.all(fresh.map((m) => toGraphEmail(m, mailbox, token))),
      newestMessageId: newest ? (newest.internetMessageId ?? newest.id ?? null) : null,
      newestReceivedAt: newest?.receivedDateTime ?? null,
    };
    next = data["@odata.nextLink"];
  }
}

/** Every page of graphFetchEmailPages in one array (tests, tools). */
export async function graphFetchEmails(
  mailbox: string,
  sinceDateTime?: string,
  knownMessageIds: ReadonlySet<string> = new Set(),
): Promise<GraphEmail[]> {
  const emails: GraphEmail[] = [];
  for await (const page of graphFetchEmailPages(mailbox, sinceDateTime, knownMessageIds)) {
    emails.push(...page.emails);
  }
  return emails;
}

export interface GraphUser {
  id: string;
  displayName: string;
  mail: string | null;
  mobilePhone: string | null;
}

/**
 * Maps raw Graph API group member records to typed GraphUser objects.
 * Filters to real user objects (not nested groups or service principals)
 * and drops any member without a valid string id.
 */
export function mapGroupMembersToUsers(
  rawMembers: Array<Record<string, unknown>>,
): GraphUser[] {
  return rawMembers
    .filter(
      (m) =>
        m["@odata.type"] === "#microsoft.graph.user" &&
        typeof m.id === "string" &&
        m.id,
    )
    .map((m) => ({
      id: m.id as string,
      displayName: String(m.displayName ?? ""),
      mail: typeof m.mail === "string" ? m.mail : null,
      mobilePhone: typeof m.mobilePhone === "string" ? m.mobilePhone : null,
    }));
}

export async function graphGetGroupUsers(groupId: string): Promise<GraphUser[]> {
  const token = await getGraphToken();
  const url = `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(groupId)}/members?$select=id,displayName,mail,mobilePhone`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`graphGetGroupUsers failed: ${resp.status} — ${text}`);
  }
  const data = (await resp.json()) as { value: Array<Record<string, unknown>> };
  return mapGroupMembersToUsers(data.value ?? []);
}
