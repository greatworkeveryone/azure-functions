// Sender authentication for Graph-synced mail. The From header alone is
// spoofable; this decides from the transport headers Exchange Online stamped
// whether the From address was actually authenticated. Pure — no I/O.
//
// Internal mail: Exchange stamps `X-MS-Exchange-Organization-AuthAs: Internal`
// when the sender authenticated as a user of this org (DMARC isn't evaluated
// intra-org, so there's no Authentication-Results to read). The header
// firewall strips X-MS-Exchange-Organization-* from mail arriving from
// untrusted (internet) sources and re-stamps AuthAs (Anonymous), so outsiders
// can't forge it. Belt and braces: it must appear exactly once, any
// X-MS-Exchange-CrossTenant-AuthAs must agree, and the From domain must be in
// ORG_EMAIL_DOMAINS (unset = internal path disabled, fail closed).
//
// External mail: EOP prepends its own `Authentication-Results` (no authserv-id,
// unlike RFC 8601), so a sender can inject a fake one lower down. Only the
// topmost one counts: dmarc=pass with header.from equal to the From domain.
// dmarc=bestguesspass (no published policy) is not a pass.
//
// ORG_EMAIL_DOMAINS: comma-separated accepted domains of the tenant
// (e.g. "randazzo.properties"), case-insensitive, exact domain match.

export interface MessageHeader {
  name: string;
  value: string;
}

export interface SenderAuthResult {
  authenticated: boolean;
  summary: string | null;
}

const SUMMARY_MAX = 2000;
const AUTH_AS = "x-ms-exchange-organization-authas";
const CROSS_TENANT_AUTH_AS = "x-ms-exchange-crosstenant-authas";
const AUTH_RESULTS = "authentication-results";

export function orgEmailDomains(): string[] {
  return (process.env.ORG_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

function domainOf(address: string): string | null {
  const at = address.trim().lastIndexOf("@");
  const domain = at >= 0 ? address.trim().slice(at + 1).toLowerCase() : "";
  return domain.length > 0 ? domain : null;
}

function valuesOf(headers: readonly MessageHeader[], name: string): string[] {
  return headers.filter((h) => h.name.trim().toLowerCase() === name).map((h) => h.value.trim());
}

function summarise(lines: string[]): string | null {
  return lines.length > 0 ? lines.join("\n").slice(0, SUMMARY_MAX) : null;
}

function isInternal(headers: readonly MessageHeader[], fromDomain: string, orgDomains: readonly string[]): boolean {
  const authAs = valuesOf(headers, AUTH_AS);
  const crossTenant = valuesOf(headers, CROSS_TENANT_AUTH_AS);
  return (
    authAs.length === 1 &&
    authAs[0].toLowerCase() === "internal" &&
    crossTenant.every((v) => v.toLowerCase() === "internal") &&
    orgDomains.includes(fromDomain)
  );
}

// `…;dmarc=pass action=none header.from=contoso.com;…` → result + header.from.
function dmarcOf(authResults: string): { fromDomain: string | null; result: string } | null {
  const clause = authResults
    .split(";")
    .map((c) => c.replace(/\([^)]*\)/g, " ").trim())
    .find((c) => /^dmarc=/i.test(c));
  if (!clause) return null;
  const result = /^dmarc=([^\s;]+)/i.exec(clause)?.[1]?.toLowerCase() ?? "";
  const from = /\bheader\.from=([^\s;]+)/i.exec(clause)?.[1]?.toLowerCase() ?? null;
  return { fromDomain: from, result };
}

export function assessSenderAuth(
  headers: readonly MessageHeader[],
  fromAddress: string,
  orgDomains: readonly string[] = orgEmailDomains(),
): SenderAuthResult {
  const fromDomain = domainOf(fromAddress);

  const authAsLines = [AUTH_AS, CROSS_TENANT_AUTH_AS].flatMap((name) =>
    headers.filter((h) => h.name.trim().toLowerCase() === name).map((h) => `${h.name.trim()}: ${h.value.trim()}`),
  );
  if (fromDomain && isInternal(headers, fromDomain, orgDomains)) {
    return { authenticated: true, summary: summarise(authAsLines) };
  }

  const results = valuesOf(headers, AUTH_RESULTS);
  const resultLines = results.map((v) => `Authentication-Results: ${v}`);
  const top = results.length > 0 ? dmarcOf(results[0]) : null;
  const authenticated = Boolean(fromDomain && top && top.result === "pass" && top.fromDomain === fromDomain);

  return { authenticated, summary: summarise(resultLines.length > 0 ? resultLines : authAsLines) };
}
