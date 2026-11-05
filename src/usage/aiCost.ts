import { assertSafeToddlerUrl } from "../toddlerUrl";
import type { UsagePeriod } from "./period";

// The AI server's Azure cost for a period, from toddler's GET /usage/cost (it reads Azure Cost Management with
// its own managed identity in the GWE subscription).
// Toddler being off or unconfigured is an ordinary answer here, not an error: the page falls back to its estimate.

export interface AiCostDto {
  available: true;
  byCategory: { category: string; cost: number }[];
  currency: string;
  daily: { cost: number; day: string }[];
  fetchedAt: string;
  from: string;
  to: string;
  total: number;
}

export interface AiCostUnavailable {
  available: false;
  reason: string;
}

const TIMEOUT_MS = 25_000;

function isCostBody(body: unknown): body is Omit<AiCostDto, "available"> {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Record<string, unknown>;
  return typeof value.total === "number" && typeof value.currency === "string" && Array.isArray(value.daily) && Array.isArray(value.byCategory);
}

export async function fetchAiCost(period: UsagePeriod, env: NodeJS.ProcessEnv = process.env): Promise<AiCostDto | AiCostUnavailable> {
  const url = (env.TODDLER_URL ?? "").replace(/\/+$/, "");
  const key = env.TODDLER_SERVICE_KEY ?? "";
  if (!url || !key) return { available: false, reason: "The AI server is not connected to this Floorplan." };
  assertSafeToddlerUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ from: period.from, to: period.to });
    const response = await fetch(`${url}/usage/cost?${query.toString()}`, { headers: { "X-Service-Key": key }, redirect: "error", signal: controller.signal });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const error = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
      return { available: false, reason: error ?? `The AI server answered ${response.status}.` };
    }
    const body: unknown = await response.json();
    if (!isCostBody(body)) return { available: false, reason: "The AI server's cost answer was not in the expected shape." };
    return { ...body, available: true };
  } catch {
    // Off (dev schedule), restarting or unreachable: all read the same to a director.
    return { available: false, reason: "The AI server could not be reached. It may be switched off." };
  } finally {
    clearTimeout(timer);
  }
}
