// Keeps personal data out of Sentry events from the Functions app (SECF-03, L1): email addresses are
// redacted from any text, the event user keeps only an opaque id, and request bodies, cookies and
// credentials are dropped. Upstream error messages and attachment file names can carry addresses.
import type { Breadcrumb, Event } from "@sentry/node";

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const DROPPED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-app-token", "x-functions-key"]);

export function scrubText(text: string): string {
  return text.replace(EMAIL_IN_TEXT, "[email]");
}

function scrubRecord<V>(record: Record<string, V>): Record<string, V | string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? scrubText(value) : value]));
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const out = { ...breadcrumb };
  if (out.message) out.message = scrubText(out.message);
  if (out.data) out.data = scrubRecord(out.data);
  return out;
}

export function scrubEvent<T extends Event>(event: T): T {
  const out: T = { ...event };
  if (typeof out.message === "string") out.message = scrubText(out.message);
  if (typeof out.transaction === "string") out.transaction = scrubText(out.transaction);
  if (out.request) {
    const { cookies: _cookies, data: _data, ...rest } = out.request;
    const request = { ...rest };
    if (request.url) request.url = scrubText(request.url);
    if (typeof request.query_string === "string") request.query_string = scrubText(request.query_string);
    if (request.headers) {
      request.headers = scrubRecord(
        Object.fromEntries(Object.entries(request.headers).filter(([name]) => !DROPPED_HEADERS.has(name.toLowerCase()))),
      ) as Record<string, string>;
    }
    out.request = request;
  }
  if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb);
  if (out.extra) out.extra = scrubRecord(out.extra);
  if (out.tags) out.tags = scrubRecord(out.tags) as typeof out.tags;
  if (out.exception?.values) {
    out.exception = { ...out.exception, values: out.exception.values.map((item) => (item.value ? { ...item, value: scrubText(item.value) } : item)) };
  }
  if (out.spans) {
    out.spans = out.spans.map((span) => ({
      ...span,
      ...(typeof span.description === "string" ? { description: scrubText(span.description) } : {}),
      ...(span.data ? { data: scrubRecord(span.data) as typeof span.data } : {}),
    }));
  }
  if (out.user) out.user = out.user.id !== undefined ? { id: out.user.id } : undefined;
  return out;
}
