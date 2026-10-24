// Inbound email triage (EB3): the text a model is shown. The triage step builds it from a stored
// email; the purpose's mock reads it back, so the layout lives here and nowhere else.
//
//   Subject: Leak in the kitchen
//   Body:
//   Hi, water is coming through the ceiling ...
//
// The model is never shown the sender's address or name: who wrote the email is matched against
// Floorplan's own records by the server, not by the model.

export const TRIAGE_LIMITS = {
  bodyChars: 4_000,
  /** What the purpose accepts in all; the builder always stays under it. */
  maxInputChars: 4_400,
  subjectChars: 200,
} as const;

/** One line, no brackets of its own that could pass for the answer's. */
const squeeze = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Keeps paragraph breaks (they carry meaning) but nothing wider than a blank line. */
const tidyBody = (text: string): string => text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export function buildTriageInput(subject: string | null | undefined, body: string | null | undefined): string {
  const head = `Subject: ${squeeze(subject ?? "").slice(0, TRIAGE_LIMITS.subjectChars)}\nBody:\n`;
  return head + tidyBody(body ?? "").slice(0, TRIAGE_LIMITS.maxInputChars - head.length);
}

/** The subject and body back out of an input built above; empty strings when it is not one. */
export function readTriageInput(input: string): { body: string; subject: string } {
  const match = input.match(/^Subject: ([^\n]*)\nBody:\n([\s\S]*)$/);
  return { body: match?.[2] ?? "", subject: match?.[1] ?? "" };
}
