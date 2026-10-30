// Cleaning of free text typed by a tenant (TR3). The result is stored and shown as plain text only;
// nothing here makes it safe to render as HTML, and nothing downstream may.

// Control characters other than newline and tab, and the bidirectional / zero-width controls that can
// make text read differently from how it is stored.
const UNWANTED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Trimmed text with unwanted characters removed, or null when it is not a string. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\r\n?/g, "\n").replace(UNWANTED, "").replace(/\n{3,}/g, "\n\n").trim();
}
