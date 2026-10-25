// Sending through Microsoft Graph, draft then send: POST /users/{from}/messages makes the
// message (and tells us its Graph id and its internet message id, which a reply's
// In-Reply-To will name), POST .../send sends that draft. Splitting the two is what lets us
// keep the ids and retry a failed send without making a second message.
//
// Errors carry a CODE only: Graph's own text can hold addresses and message content, so it is
// never stored or logged. This file is new and leaves src/graph.ts and its senders alone.

import { getGraphToken } from "../graph";

export interface DraftInput {
  from: { address: string; name: string };
  html: string;
  replyTo: { address: string; name: string | null };
  subject: string;
  to: string;
}

export interface Draft {
  graphMessageId: string;
  internetMessageId: string | null;
}

export interface MailSender {
  createDraft(input: DraftInput): Promise<Draft>;
  sendDraft(from: string, graphMessageId: string): Promise<void>;
}

export type SendErrorCode =
  | "graph_auth"
  | "graph_not_configured"
  | "graph_not_found"
  | "graph_rejected"
  | "graph_throttled"
  | "graph_unavailable"
  | "network"
  | "send_unconfirmed";

export class MailSendError extends Error {
  readonly code: SendErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(code: SendErrorCode, retryable: boolean, status: number | null) {
    super(`mail send failed: ${code}`);
    this.name = "MailSendError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** The code, and whether trying again could help, for an HTTP status from Graph. */
export function classifyStatus(status: number, step: "draft" | "send"): MailSendError {
  if (status === 429) return new MailSendError("graph_throttled", true, status);
  if (status === 408 || status >= 500) return new MailSendError("graph_unavailable", true, status);
  if (status === 401 || status === 403) return new MailSendError("graph_auth", false, status);
  // The draft is gone when we ask to send it: it may already have gone. Never send it again.
  if (status === 404 && step === "send") return new MailSendError("send_unconfirmed", false, status);
  if (status === 404) return new MailSendError("graph_not_found", false, status);
  return new MailSendError("graph_rejected", false, status);
}

/** Maps anything thrown on the way to Graph into a MailSendError. */
export function toSendError(error: unknown): MailSendError {
  if (error instanceof MailSendError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Graph credentials not configured")) return new MailSendError("graph_not_configured", false, null);
  if (message.startsWith("Graph token request failed")) return new MailSendError("graph_auth", false, null);
  return new MailSendError("network", true, null);
}

const BASE = "https://graph.microsoft.com/v1.0/users";

/** A sender that takes one Graph token and reuses it for every message in a run. */
export function createGraphSender(fetchImpl: typeof fetch = fetch, tokenSource: () => Promise<string> = getGraphToken): MailSender {
  let token: string | null = null;
  const bearer = async () => (token ??= await tokenSource());

  async function post(url: string, step: "draft" | "send", body?: unknown, retried = false): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${await bearer()}`, "Content-Type": "application/json" },
        method: "POST",
      });
    } catch (error) {
      throw toSendError(error);
    }
    // An expired token is the one 401 worth a second try, with a fresh token.
    if (response.status === 401 && !retried) {
      token = null;
      return post(url, step, body, true);
    }
    if (!response.ok) throw classifyStatus(response.status, step);
    return response;
  }

  return {
    async createDraft(input) {
      const message = {
        body: { content: input.html, contentType: "HTML" },
        from: { emailAddress: { address: input.from.address, name: input.from.name } },
        isDeliveryReceiptRequested: false,
        isReadReceiptRequested: false,
        replyTo: [{ emailAddress: { address: input.replyTo.address, ...(input.replyTo.name ? { name: input.replyTo.name } : {}) } }],
        subject: input.subject,
        toRecipients: [{ emailAddress: { address: input.to } }],
      };
      const response = await post(`${BASE}/${encodeURIComponent(input.from.address)}/messages`, "draft", message);
      const created = (await response.json().catch(() => null)) as { id?: unknown; internetMessageId?: unknown } | null;
      if (typeof created?.id !== "string" || created.id === "") throw new MailSendError("graph_rejected", false, response.status);
      return { graphMessageId: created.id, internetMessageId: typeof created.internetMessageId === "string" ? created.internetMessageId : null };
    },
    async sendDraft(from, graphMessageId) {
      await post(`${BASE}/${encodeURIComponent(from)}/messages/${encodeURIComponent(graphMessageId)}/send`, "send");
    },
  };
}
