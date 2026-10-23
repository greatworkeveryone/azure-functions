// Teams tab deep links (WP63). A link opens the Floorplan tab and hands it the
// in-app path as subEntityId; the tab reads it back and router.replace()s there.
// The path is the one absoluteLink() gets from an adapter's deepLink() or jobPath().
//
// Mirrored rule: the frontend validates subEntityId with the same checks before it
// navigates (FE src/lib/teams/appRoute.ts). Change both together.

/** Top-level app routes a Teams alert may open. */
export const TEAMS_ROUTE_PREFIXES: readonly string[] = [
  "/activity",
  "/dashboard",
  "/escalations",
  "/finance",
  "/incoming",
  "/inspections",
  "/jobs",
  "/keys",
  "/maintenance",
  "/quotes",
  "/tenancy",
];

// C0 controls and DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// A ".." segment, plain or percent-encoded, in the path part.
const DOT_SEGMENT = /(^|\/)(\.|%2e){2}(\/|$)/i;

/** An internal path on the allow-list: "/", not "//", no backslash, scheme, control char or "..". */
export function isSafeAppRoute(route: unknown): route is string {
  if (typeof route !== "string" || !route.startsWith("/") || route.startsWith("//")) return false;
  if (route.includes("\\") || CONTROL_CHARS.test(route)) return false;
  const path = route.split(/[?#]/, 1)[0];
  if (path.includes(":") || DOT_SEGMENT.test(path)) return false;
  return TEAMS_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The Teams link that opens the Floorplan tab at `route`. Throws on an unsafe route. */
export function teamsTabLink(appId: string, route: string): string {
  if (!isSafeAppRoute(route)) throw new Error(`Unsafe Teams deep-link route: ${JSON.stringify(route)}`);
  const context = encodeURIComponent(JSON.stringify({ subEntityId: route }));
  return `https://teams.microsoft.com/l/entity/${encodeURIComponent(appId)}/floorplan?context=${context}`;
}
