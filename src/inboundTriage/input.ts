// Inbound email triage (EB3): what the routes accept, checked before the database is touched. The
// person acting is never taken from the body: their name and id come from the verified token.

export type Parsed<T> = { error: string; ok: false } | { ok: true; value: T };

const MAX_INT = 2_147_483_647;
export const MAX_EMAIL_IDS = 100;
export const MAX_NOTE_CHARS = 300;

const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_INT;

/** `emailIds=1,2,3` from the query string. */
export function parseEmailIds(raw: string | null): Parsed<number[]> {
  const parts = (raw ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0 || parts.length > MAX_EMAIL_IDS) return fail(`Send between 1 and ${MAX_EMAIL_IDS} email ids.`);
  const ids = parts.map((part) => (/^\d{1,10}$/.test(part) ? Number(part) : NaN));
  if (!ids.every(isId)) return fail("Each email id must be a whole number above zero.");
  return { ok: true, value: [...new Set(ids)] };
}

export interface AssignBody {
  assigneeUserId: number;
  emailId: number;
  expectedAssigneeUserId: number | null;
  note: string | null;
}

export function parseAssignBody(body: Record<string, unknown>): Parsed<AssignBody> {
  if (!isId(body.emailId)) return fail("emailId must be a whole number above zero.");
  if (!isId(body.assigneeUserId)) return fail("assigneeUserId must be a whole number above zero.");
  const expected = body.expectedAssigneeUserId === undefined || body.expectedAssigneeUserId === null ? null : body.expectedAssigneeUserId;
  if (expected !== null && !isId(expected)) return fail("expectedAssigneeUserId must be a whole number above zero, or null.");
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.note)) {
      return fail(`The note must be plain text of up to ${MAX_NOTE_CHARS} characters.`);
    }
    note = body.note.trim() === "" ? null : body.note.trim();
  }
  return { ok: true, value: { assigneeUserId: body.assigneeUserId, emailId: body.emailId, expectedAssigneeUserId: expected, note } };
}
