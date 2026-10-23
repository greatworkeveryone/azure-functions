// Which AI_BASE_URL values the gateway will call (docs/runbooks/switches.md).
//
// https to any host, because the connection is encrypted. Plain http only to this machine or a
// private (RFC 1918) address, for a self-hosted endpoint on Randazzo Properties' own network:
// anything else would send prompts across the internet in the clear. A host name over http is
// refused even if it looks internal, because a name cannot be checked without asking DNS, and
// its answer can change; give the address, or put https in front.
//
// A problem is a fixed sentence for the server log. It never repeats the address, so a secret
// that was pasted into one cannot reach a log.

export type BaseUrlCheck = { ok: true } | { ok: false; problem: string };

const HTTPS_OR_PRIVATE =
  "AI_BASE_URL must use https. Plain http is allowed only to localhost or a private address (10.x.x.x, 172.16.x.x to 172.31.x.x, 192.168.x.x), so nothing readable crosses the internet";

const problem = (text: string): BaseUrlCheck => ({ ok: false, problem: text });

/** The four numbers of a dotted IPv4 address as `new URL` writes it (it has already read hex, octal and whole-number forms), else null. */
function octetsOf(hostname: string): number[] | null {
  const found = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!found) return null;
  const octets = found.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** This machine, or a private (RFC 1918) address: the only places plain http may go. */
function isLocalOrPrivate(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = octetsOf(hostname);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function checkBaseUrl(raw: string | null): BaseUrlCheck {
  if (!raw) return problem("AI_BASE_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return problem("AI_BASE_URL is not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return problem(HTTPS_OR_PRIVATE);
  if (parsed.username || parsed.password) return problem("AI_BASE_URL must not contain a user name or password; put a key in AI_API_KEY");
  if (raw.includes("?") || raw.includes("#")) return problem("AI_BASE_URL must not contain a query string or fragment");

  const octets = octetsOf(parsed.hostname);
  if (octets && octets[0] === 169 && octets[1] === 254) {
    return problem("AI_BASE_URL points at a link-local address (169.254.x.x, the cloud metadata range), which is never an AI endpoint");
  }
  if (parsed.protocol === "http:" && !isLocalOrPrivate(parsed.hostname)) return problem(HTTPS_OR_PRIVATE);
  return { ok: true };
}
