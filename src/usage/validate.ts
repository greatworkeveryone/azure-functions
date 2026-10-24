// What the browser may send to postUsageEvents, checked field by field before the database is
// touched. The shape is deliberately narrow: closed lists for the device, a module key and a route
// PATTERN that cannot carry an id or a query string, and counts that cannot be inflated. The
// person is never in the body: it comes from the verified token.

export const MAX_BODY_CHARS = 8000;
export const MAX_VIEWS_PER_BATCH = 20;
export const MAX_VIEW_SECONDS_PER_BATCH = 900;
export const MAX_BATCH_SECONDS = 1800;
export const MAX_SEQ = 1_000_000;

export const DEVICE_CLASSES = ["phone", "tablet", "desktop"] as const;
export const BROWSER_FAMILIES = ["Chrome", "Edge", "Firefox", "Safari", "Samsung Internet", "Other"] as const;
export const OS_FAMILIES = ["Windows", "macOS", "iOS", "Android", "Linux", "Other"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

const DEVICE_ID = /^[ds]_[A-Za-z0-9]{16,32}$/;
const SESSION_ID = /^x_[A-Za-z0-9]{16,32}$/;
// Words and hyphens only, so a number or an id can never be a path segment.
const WORD = "[a-z]+(?:-[a-z]+)*";
const MODULE_KEY = new RegExp(`^${WORD}(?:/${WORD}){0,2}$`);
const ROUTE_SEGMENT = new RegExp(`^(?:${WORD}|\\[[a-zA-Z]+\\])$`);
const MAX_ROUTE_CHARS = 120;
const PAST_LIMIT_MS = 26 * 60 * 60 * 1000;
const FUTURE_LIMIT_MS = 5 * 60 * 1000;

export interface UsageViewInput {
  activeSeconds: number;
  continued: boolean;
  enteredAt: Date;
  module: string;
  route: string;
  seq: number;
}

export interface UsageBatch {
  device: { browser: string; class: DeviceClass; id: string; osFamily: string; persistent: boolean };
  sessionId: string;
  views: UsageViewInput[];
}

export type ParsedBatch = { error: string } | { batch: UsageBatch };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => list.find((item) => item === value) ?? null;

function routeIsPattern(route: string): boolean {
  if (route === "/") return true;
  if (route.length > MAX_ROUTE_CHARS || !route.startsWith("/")) return false;
  return route.slice(1).split("/").every((segment) => ROUTE_SEGMENT.test(segment));
}

function parseView(raw: unknown, now: Date): UsageViewInput | string {
  if (!isRecord(raw)) return "each view must be an object";
  const { activeSeconds, continued, enteredAt, module, route, seq } = raw;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) return "view seq must be a whole number from 1 to 1000000";
  if (typeof module !== "string" || !MODULE_KEY.test(module) || module.length > 64) return "view module is not a module key";
  if (typeof route !== "string" || !routeIsPattern(route)) return "view route must be a route pattern with no ids or query string";
  if (typeof activeSeconds !== "number" || !Number.isInteger(activeSeconds) || activeSeconds < 0 || activeSeconds > MAX_VIEW_SECONDS_PER_BATCH) {
    return `view activeSeconds must be a whole number from 0 to ${MAX_VIEW_SECONDS_PER_BATCH}`;
  }
  if (continued !== undefined && typeof continued !== "boolean") return "view continued must be true or false";
  const entered = typeof enteredAt === "string" ? new Date(enteredAt) : null;
  if (!entered || Number.isNaN(entered.getTime())) return "view enteredAt must be a date and time";
  const age = now.getTime() - entered.getTime();
  if (age > PAST_LIMIT_MS || age < -FUTURE_LIMIT_MS) return "view enteredAt is too far from now";
  return { activeSeconds, continued: continued === true, enteredAt: entered, module, route, seq };
}

export function parseUsageBatch(body: unknown, now: Date = new Date()): ParsedBatch {
  if (!isRecord(body)) return { error: "Send a JSON object" };
  const { device, sessionId, views } = body;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return { error: "sessionId is not a session id" };
  if (!isRecord(device)) return { error: "device is required" };
  if (typeof device.id !== "string" || !DEVICE_ID.test(device.id)) return { error: "device.id is not a device id" };
  const deviceClass = oneOf(DEVICE_CLASSES, device.class);
  const browser = oneOf(BROWSER_FAMILIES, device.browser);
  const osFamily = oneOf(OS_FAMILIES, device.os);
  if (!deviceClass) return { error: `device.class must be one of: ${DEVICE_CLASSES.join(", ")}` };
  if (!browser) return { error: "device.browser is not a browser family" };
  if (!osFamily) return { error: "device.os is not an operating system family" };
  if (!Array.isArray(views) || views.length < 1 || views.length > MAX_VIEWS_PER_BATCH) {
    return { error: `views must be a list of 1 to ${MAX_VIEWS_PER_BATCH}` };
  }
  const parsed: UsageViewInput[] = [];
  for (const raw of views) {
    const view = parseView(raw, now);
    if (typeof view === "string") return { error: view };
    if (parsed.some((other) => other.seq === view.seq)) return { error: "view seq values must be different" };
    parsed.push(view);
  }
  if (parsed.reduce((sum, view) => sum + view.activeSeconds, 0) > MAX_BATCH_SECONDS) return { error: `A batch may carry at most ${MAX_BATCH_SECONDS} active seconds` };
  return {
    batch: { device: { browser, class: deviceClass, id: device.id, osFamily, persistent: device.id.startsWith("d_") }, sessionId, views: parsed },
  };
}
