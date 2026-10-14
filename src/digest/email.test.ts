/// <reference types="jest" />
import { buildDigestEmail, formatDisplayDate } from "./email";
import type { DigestItem, DigestUser } from "./types";

const user: DigestUser = { email: "fay@randazzo.properties", name: "Fay Staff", optedOut: false, role: "facilities_manager", userId: 1 };
const BASE = "https://floorplan.randazzo.properties";

function item(n: number, over: Partial<DigestItem> = {}): DigestItem {
  return { dedupeKey: `job:${n}`, kind: "approval", line: `Job #${n} · Fix the lift`, order: n, path: `/jobs?jobId=${n}`, ...over };
}

const build = (items: DigestItem[], over: { baseUrl?: string | null; overriddenFrom?: string | null } = {}) =>
  buildDigestEmail(user, items, { baseUrl: BASE, maxLines: 5, today: "2026-10-14", overriddenFrom: null, ...over });

describe("the subject", () => {
  it("counts the items and carries the date, day first", () => {
    expect(build([item(1), item(2), item(3)]).subject).toBe("Floorplan 14/10/2026: 3 items need you");
    expect(build([item(1)]).subject).toBe("Floorplan 14/10/2026: 1 item needs you");
  });

  it("counts every item, not just the ones shown", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(i + 1));
    expect(build(items).subject).toBe("Floorplan 14/10/2026: 8 items need you");
  });

  it("never contains an amount, a tenant name or anything from the items (it shows on a lock screen)", () => {
    const hostile = [
      item(1, { line: "Approve quote $4,840.00 for ACME Air Pty Ltd" }),
      item(2, { line: "Rent review for Smith & Co, $12,345 a year" }),
    ];
    const { subject } = build(hostile);
    expect(subject).not.toMatch(/\$|\d,\d{3}|ACME|Smith/);
    expect(subject).not.toContain("Fix the lift");
    expect(subject).not.toContain(user.name);
  });
});

describe("the body", () => {
  it("lists at most five lines, each with its absolute deep link", () => {
    const items = Array.from({ length: 5 }, (_, i) => item(i + 1));
    const { body } = build(items);
    for (let n = 1; n <= 5; n += 1) {
      expect(body).toContain(`Job #${n} · Fix the lift`);
      expect(body).toContain(`${BASE}/jobs?jobId=${n}`);
    }
    expect(body).not.toMatch(/and \d+ more/);
  });

  it("says 'and N more' with a link to the dashboard when there are more than five", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(i + 1));
    const { body } = build(items);
    expect(body).toContain(`${BASE}/jobs?jobId=5`);
    expect(body).not.toContain("jobId=6");
    expect(body).toContain(`and 3 more: ${BASE}/dashboard`);
  });

  it("opens with a line that carries no job detail, then the list", () => {
    const { body } = build([item(1, { line: "Secret detail" })]);
    const lines = body.split("\n");
    expect(lines[0]).toBe("Good morning Fay,");
    expect(lines[2]).toBe("1 thing needs you in Floorplan today.");
    expect(lines[0] + lines[2]).not.toContain("Secret detail");
  });

  it("tells the person how to stop it", () => {
    expect(build([item(1)]).body).toMatch(/only .* when something needs you/i);
    expect(build([item(1)]).body).toMatch(/Morning digest email/);
  });

  it("falls back to relative paths when APP_BASE_URL is not set (dry run)", () => {
    const { body } = build([item(1)], { baseUrl: null });
    expect(body).toContain("/jobs?jobId=1");
    expect(body).not.toContain("https://");
  });

  it("says who it was meant for when DEV_EMAIL_OVERRIDE redirected it", () => {
    expect(build([item(1)], { overriddenFrom: "real@randazzo.properties" }).body).toContain("meant for real@randazzo.properties");
    expect(build([item(1)]).body).not.toContain("meant for");
  });
});

describe("dates", () => {
  it("formats YYYY-MM-DD as DD/MM/YYYY", () => {
    expect(formatDisplayDate("2026-01-05")).toBe("05/01/2026");
  });
});
