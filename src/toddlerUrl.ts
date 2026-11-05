import { isDevOverrideEnabled } from "./jwt";

// The service key and SAS URLs go in these requests: https only, except
// loopback or the local dev override. Throws a config error otherwise.
export function assertSafeToddlerUrl(url: string, devOverride: boolean = isDevOverrideEnabled()): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TODDLER_URL is not a valid URL");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !devOverride && !loopback) {
    throw new Error("TODDLER_URL must use https: (the service key and file URLs are sent to it)");
  }
}
