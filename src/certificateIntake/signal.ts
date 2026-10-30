// Certificate intake (TR8): does an Incoming email look like a contractor sending their certificate of
// currency? Pure. Deterministic keyword rules decide; an AI reading of the email (when AI is on) only
// adds confidence, it can never create a suggestion on its own. A suggestion is a hint on the email:
// nothing is filed until a person files it.

import type { SenderKind } from "../inboundTriage/types";

export interface EmailAttachmentRef {
  blobName: string;
  contentType: string;
  fileName: string;
}

export interface CertificateSignalInput {
  /** Text from the existing AI reading of the email (classification and parsed data); null when AI is off or never read it. */
  aiText: string | null;
  attachments: readonly EmailAttachmentRef[];
  body: string | null;
  senderKind: SenderKind;
  /** Exchange verified the From address (SPF, DKIM, DMARC). An unverified sender is never believed. */
  senderVerified: boolean;
  subject: string | null;
}

export interface CertificateSignal {
  /** "rules": keywords alone. "rules_ai": the AI reading of the email points the same way. */
  confidence: "rules" | "rules_ai";
  /** The kinds of cover the email names, in the register's wording. */
  insuranceTypes: string[];
  /** Plain sentences, most telling first. */
  reasons: string[];
}

const FILE_TYPES: Record<string, string> = { jpeg: "image/jpeg", jpg: "image/jpeg", pdf: "application/pdf", png: "image/png", webp: "image/webp" };

/** The attachment's media type when the register accepts it (PDF, JPEG, PNG, WebP), from its file name; null otherwise. */
export function certificateFileType(fileName: string): string | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  return extension ? (FILE_TYPES[extension] ?? null) : null;
}

const STRONG = /\b(?:certificates?\s+of\s+(?:currency|insurance)|insurance\s+certificates?|currency\s+certificates?|certificates?\s+of\s+cover|c\.?o\.?c\.?|c\.?o\.?i\.?)\b/i;
const COVER_TYPES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "Public liability", pattern: /\bpublic\s+(?:and\s+products\s+)?liability\b|\bpl\s+insurance\b/i },
  { label: "Workers compensation", pattern: /\bworkers'?\s*comp(?:ensation)?\b|\bworkcover\b/i },
  { label: "Professional indemnity", pattern: /\bprofessional\s+indemnity\b|\bpi\s+insurance\b/i },
];
const AI_WORDS = /certificate\s+of\s+(?:currency|insurance)|insurance\s+certificate|public\s+liability|workers'?\s*comp|professional\s+indemnity/i;

/**
 * The suggestion for one email, or null. All three must hold: the sender is a verified contractor, there is a
 * file the register can keep, and the subject, body or file names talk about a certificate of currency or a kind
 * of cover (a bare mention of "insurance" is not enough).
 */
export function certificateSignal(input: CertificateSignalInput): CertificateSignal | null {
  if (input.senderKind !== "contractor" || !input.senderVerified) return null;
  const files = input.attachments.filter((file) => certificateFileType(file.fileName) !== null);
  if (files.length === 0) return null;

  const fileNames = files.map((file) => file.fileName).join(" ");
  const text = `${input.subject ?? ""}\n${(input.body ?? "").slice(0, 4000)}\n${fileNames}`;
  const strong = STRONG.test(text);
  const types = COVER_TYPES.filter((type) => type.pattern.test(text)).map((type) => type.label);
  if (!strong && types.length === 0) return null;

  const reasons = [
    strong ? "The email mentions a certificate of currency or insurance certificate." : `The email mentions ${types.join(", ").toLowerCase()} cover.`,
    `It is from a contractor, with ${files.length === 1 ? "a file" : `${files.length} files`} attached.`,
  ];
  const aiAgrees = input.aiText !== null && AI_WORDS.test(input.aiText);
  if (aiAgrees) reasons.push("The AI reading of the email agrees.");
  return { confidence: aiAgrees ? "rules_ai" : "rules", insuranceTypes: types, reasons };
}
