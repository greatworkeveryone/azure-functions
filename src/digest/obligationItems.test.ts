/// <reference types="jest" />
// The digest reads the same obligations as the inbox: one line for everything that waits on the person (decide and
// do), none for what they are waiting on others for, and the same count as the app's.

import { deriveObligations, waitingOnMe } from "../obligations/derive";
import { viewerOf, world } from "../__tests__/fixtures/obligationsWorld";
import { obligationItems } from "./obligationItems";
import { deriveItems } from "./items";
import type { DigestFacts, DigestUser } from "./types";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn(), timer: jest.fn() } }));

const user = (role: string, userId: number, oid: string, name: string): DigestUser => ({ email: `${oid}@example.test`, entraOid: oid, lastSentOn: null, name, optedOut: false, role, userId });

describe("the digest's lines come from the obligations", () => {
  const { ctx, sources } = world();
  const loaded = { context: ctx, sources, unavailable: [] };
  const director = user("director", 7, "o7", "Dan Director");

  it("has exactly as many lines as the app counts as waiting on the person", () => {
    const lines = obligationItems(director, loaded);
    expect(lines.length).toBe(waitingOnMe(deriveObligations(sources, viewerOf("director"), ctx).totals));
    expect(lines.some((line) => line.line.includes("Approve as director") && line.path.includes("quote"))).toBe(true);
  });

  it("leaves out what the person is only waiting on, and any amount", () => {
    const lines = obligationItems(user("facilities", 2, "o2", "Fran Officer"), loaded);
    expect(lines.map((line) => line.line).join(" ")).not.toMatch(/Waiting for approval|\$|60,000/);
  });

  it("is what deriveItems answers when it is given the obligations", () => {
    const facts = { dueJobs: [], escalations: [], overdueKeys: [], users: [director], waitingApprovals: [] } as DigestFacts;
    const items = deriveItems(director, facts, { authorityFacts: () => ctx.authority, now: ctx.now, obligations: loaded });
    expect(items.length).toBe(obligationItems(director, loaded).length);
  });
});
