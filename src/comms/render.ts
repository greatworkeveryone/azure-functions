// ─────────────────────────────────────────────────────────────────────────────
// A merged email as the recipient gets it: branded HTML (header, body, signature,
// footer) and a plain-text version of the same words.
//
// The layout is the only thing that controls branding; authors control content. No
// images are loaded and no link is rewritten: there are no tracking pixels and no link
// tracking. Every piece of text is escaped here, and a link keeps its address only if
// it is http, https or mailto. Pure.
// ─────────────────────────────────────────────────────────────────────────────

import { parseInline, restoreInline, splitFields, type InlineToken, type MarkdownBlock } from "./markdown";
import type { Signature } from "./signature";

/** Randazzo Properties' document ink (the frontend's DOCUMENT_BRAND.ink). */
const INK = "#104162";
const TEXT = "#1f2933";
const MUTED = "#52606d";
const RULE = "#d9dee3";
const FONT = "Arial, Helvetica, sans-serif";

export interface RenderInput {
  blocks: readonly MarkdownBlock[];
  companyName: string;
  /** Printed under the company name in the footer when set. */
  companyAddress: string | null;
  /** The reply-to as a person reads it; shown so a reply is not a surprise. */
  replyTo: { address: string; name: string | null };
  signature: Signature;
  /** "You are receiving this because …", or null for mail that needs no reason (a letter). */
  receivingReason: string | null;
  /** The subject as merged, with markers still in it. */
  subject: string;
}

export interface RenderedEmail {
  html: string;
  subject: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function inlineHtml(text: string): string {
  return parseInline(text)
    .map((token: InlineToken) => {
      switch (token.kind) {
        case "strong":
          return `<strong>${escapeHtml(token.text)}</strong>`;
        case "em":
          return `<em>${escapeHtml(token.text)}</em>`;
        case "code":
          return `<code style="font-family:Consolas,Menlo,monospace;font-size:13px;">${escapeHtml(token.text)}</code>`;
        case "link":
          return SAFE_HREF.test(token.href.trim())
            ? `<a href="${escapeHtml(token.href.trim())}" style="color:${INK};">${escapeHtml(token.text)}</a>`
            : escapeHtml(token.text);
        case "field":
          return escapeHtml(`{{${token.path}}}`);
        case "text":
          return escapeHtml(token.text);
      }
    })
    .join("");
}

function inlinePlain(text: string): string {
  return parseInline(text)
    .map((token: InlineToken) => {
      if (token.kind === "link") return SAFE_HREF.test(token.href.trim()) ? `${token.text} (${token.href.trim()})` : token.text;
      if (token.kind === "field") return `{{${token.path}}}`;
      return token.text;
    })
    .join("");
}

const asTyped = (text: string): string => splitFields(text).map((part) => (part.kind === "field" ? `{{${part.path}}}` : part.text)).join("");

const P = `margin:0 0 14px 0;`;

function blockHtml(block: MarkdownBlock): string {
  switch (block.kind) {
    case "heading": {
      const size = block.level === 2 ? 18 : 16;
      return `<h${block.level} style="margin:22px 0 10px 0;font-size:${size}px;line-height:1.3;color:${INK};">${escapeHtml(asTyped(block.text))}</h${block.level}>`;
    }
    case "paragraph":
      return `<p style="${P}">${inlineHtml(block.text)}</p>`;
    case "quote":
      return `<p style="${P}padding:0 0 0 14px;border-left:3px solid ${RULE};color:${MUTED};">${inlineHtml(block.text)}</p>`;
    case "rule":
      return `<hr style="border:0;border-top:1px solid ${RULE};margin:18px 0;">`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li style="margin:0 0 6px 0;">${inlineHtml(item)}</li>`).join("");
      return `<${tag} style="margin:0 0 14px 0;padding-left:22px;">${items}</${tag}>`;
    }
    case "table": {
      const cell = (tag: "td" | "th", text: string) =>
        `<${tag} align="left" style="padding:6px 10px;border:1px solid ${RULE};font-size:14px;${tag === "th" ? `background:#f4f6f8;color:${INK};` : ""}">${inlineHtml(text)}</${tag}>`;
      const head = `<tr>${block.header.map((text) => cell("th", text)).join("")}</tr>`;
      const rows = block.rows.map((row) => `<tr>${row.map((text) => cell("td", text)).join("")}</tr>`).join("");
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px 0;">${head}${rows}</table>`;
    }
  }
}

function blockPlain(block: MarkdownBlock): string {
  switch (block.kind) {
    case "heading":
      return asTyped(block.text);
    case "paragraph":
    case "quote":
      return inlinePlain(block.text);
    case "rule":
      return "----";
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${inlinePlain(item)}`).join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.map(inlinePlain).join(" | ")).join("\n");
  }
}

function signatureHtml(signature: Signature): string {
  const lines = signature.lines.map((line, index) =>
    index === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line),
  );
  if (signature.phone) lines.push(`Phone ${escapeHtml(signature.phone)}`);
  if (signature.email) lines.push(`<a href="mailto:${escapeHtml(signature.email)}" style="color:${INK};">${escapeHtml(signature.email)}</a>`);
  return `<p style="margin:22px 0 0 0;">Kind regards,</p><p style="margin:6px 0 0 0;">${lines.join("<br>")}</p>`;
}

function signaturePlain(signature: Signature): string {
  return ["Kind regards,", ...signature.lines, ...(signature.phone ? [`Phone ${signature.phone}`] : []), ...(signature.email ? [signature.email] : [])].join("\n");
}

function footerLines(input: RenderInput): string[] {
  const replyTo = input.replyTo.name ? `${input.replyTo.name} <${input.replyTo.address}>` : input.replyTo.address;
  return [
    input.companyName,
    ...(input.companyAddress ? [input.companyAddress] : []),
    ...(input.receivingReason ? [input.receivingReason] : []),
    `Replies to this email go to ${replyTo}.`,
  ];
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const subject = restoreInline(input.subject);
  const body = input.blocks.map(blockHtml).join("\n");
  const footer = footerLines(input).map((line, index) =>
    index === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line),
  );
  const html = `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${RULE};font-family:${FONT};color:${TEXT};">
<tr><td style="padding:20px 28px;border-bottom:2px solid ${INK};font-size:20px;font-weight:bold;color:${INK};">${escapeHtml(input.companyName)}</td></tr>
<tr><td style="padding:26px 28px 22px 28px;font-size:15px;line-height:1.55;">
${body}
${signatureHtml(input.signature)}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid ${RULE};font-size:12px;line-height:1.6;color:${MUTED};">${footer.join("<br>")}</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = [input.companyName, input.blocks.map(blockPlain).join("\n\n"), signaturePlain(input.signature), footerLines(input).join("\n")].join("\n\n");
  return { html, subject, text };
}
