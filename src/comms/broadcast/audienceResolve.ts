// Turning what the database holds into the people an email would go to. Pure: the loaders read, this decides.
//
// Each selection yields candidates and exclusions. Candidates are then de-duplicated by address (lower case),
// keeping the record with the most merge values so the email can be filled in as fully as possible, and the
// counts say how many of each kind remain. Nothing here makes up an address or a name.

import { mailbox } from "../fields";
import type { RecipientType } from "../compose";
import { MAX_TYPED_CHARS } from "./audienceInput";
import type { AudienceRecipient, AudienceRequest, Candidate, ContractorRow, Exclusion, OccupancyRow, ResolvedAudience, StaffRow, TenancyRow } from "./types";

const SPLIT = /[;,\s]+/;
const MAX_VALUE = 500;
const same = (a: string, b: string): boolean => a.trim().toLocaleLowerCase("en-AU") === b.trim().toLocaleLowerCase("en-AU");

/** "2026-03-01" → "01/03/2026"; anything else (a free-text date) is not printed as a date. */
export function dateText(value: string | null): string | null {
  const match = value === null ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

/** One stored or typed address field as the single addresses it holds ("a@x; b@y" is two), each checked. */
export function addressesIn(raw: string | null): { invalid: string[]; valid: string[] } {
  const parts = (raw ?? "").split(SPLIT).filter((part) => part !== "");
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    const checked = mailbox(part, "Address");
    if (checked.ok) valid.push(checked.value);
    else invalid.push(part.slice(0, MAX_TYPED_CHARS));
  }
  return { invalid, valid: [...new Set(valid)] };
}

const clip = (value: string): string => value.slice(0, MAX_VALUE);

function premises(occupancies: readonly OccupancyRow[]): string {
  return occupancies
    .map((occupancy) => [occupancy.level, occupancy.area].map((part) => part.trim()).filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
}

function present(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null && entry[1].trim() !== "").map(([key, value]) => [key, clip(value.trim())]));
}

interface Outcome {
  candidates: Candidate[];
  excluded: Exclusion[];
}

function fromField(raw: string | null, source: RecipientType, description: string, make: (address: string, single: boolean) => Candidate): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  if (raw === null || raw.trim() === "") {
    out.excluded.push({ address: null, description, reason: "no_address", source });
    return out;
  }
  const { invalid, valid } = addressesIn(raw);
  for (const address of valid) out.candidates.push(make(address, valid.length === 1));
  for (const bad of invalid) out.excluded.push({ address: bad, description, reason: "invalid_address", source });
  return out;
}

/** The tenancy a selection reaches: not a test record, and (for chosen levels) holding an area on one of them. */
function tenancyContacts(tenancy: TenancyRow, occupancies: readonly OccupancyRow[], contacts: readonly ("accounts" | "primary")[]): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  const where = tenancy.buildingName ? ` at ${tenancy.buildingName}` : "";
  if (tenancy.isTest) {
    out.excluded.push({ address: null, description: `${tenancy.legalName}${where}`, reason: "test_record", source: "tenancy" });
    return out;
  }
  const shared = {
    "building.address": tenancy.buildingAddress,
    "building.name": tenancy.buildingName,
    "tenant.leaseExpiry": dateText(tenancy.expiry),
    "tenant.leaseStart": dateText(tenancy.commencement),
    "tenant.name": tenancy.legalName,
    "tenant.nextReview": dateText(tenancy.nextReviewDate),
    "tenant.suite": premises(occupancies),
  };
  const refId = String(tenancy.tenantId);
  const add = (outcome: Outcome) => {
    out.candidates.push(...outcome.candidates);
    out.excluded.push(...outcome.excluded);
  };
  if (contacts.includes("primary")) {
    add(
      fromField(tenancy.primaryContactEmail, "tenancy", `${tenancy.legalName}${where}, primary contact`, (address, single) => ({
        address,
        description: `${tenancy.legalName}${where}, primary contact`,
        mergeValues: present({ ...shared, "tenant.addressee": tenancy.primaryContactName, "tenant.contact": tenancy.primaryContactName }),
        name: single ? tenancy.primaryContactName : null,
        recipientRefId: refId,
        recipientType: "tenancy",
      })),
    );
  }
  if (contacts.includes("accounts")) {
    // The register holds no name for the accounts contact, so a greeting falls back to the tenant's name.
    add(
      fromField(tenancy.accountsEmail, "tenancy", `${tenancy.legalName}${where}, accounts contact`, (address) => ({
        address,
        description: `${tenancy.legalName}${where}, accounts contact`,
        mergeValues: present(shared),
        name: null,
        recipientRefId: refId,
        recipientType: "tenancy",
      })),
    );
  }
  return out;
}

export interface TenancyInputs {
  occupancies: readonly OccupancyRow[];
  tenancies: readonly TenancyRow[];
}

export function resolveTenancies(request: NonNullable<AudienceRequest["tenancies"]>, inputs: TenancyInputs): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  const done = new Set<number>();
  for (const selection of request.selections) {
    for (const tenancy of inputs.tenancies) {
      if (tenancy.buildingId !== selection.buildingId || done.has(tenancy.tenantId)) continue;
      if (!request.categories.includes(tenancy.buildingCategory)) continue;
      const held = inputs.occupancies.filter((occupancy) => occupancy.tenantId === tenancy.tenantId);
      if (selection.levels.length > 0 && !held.some((occupancy) => selection.levels.some((level) => same(level, occupancy.level)))) continue;
      done.add(tenancy.tenantId);
      const found = tenancyContacts(tenancy, held, request.contacts);
      out.candidates.push(...found.candidates);
      out.excluded.push(...found.excluded);
    }
  }
  return out;
}

export interface ContractorInputs {
  contractors: readonly ContractorRow[];
  /** Each contractor's own list of trades. */
  profiles: ReadonlyMap<number, readonly string[]>;
  /** Contractor ids the chosen buildings' coverage plans name for the chosen trades (any trade when none is chosen). */
  assignedAtBuildings: ReadonlySet<number>;
}

export function resolveContractors(request: NonNullable<AudienceRequest["contractors"]>, inputs: ContractorInputs): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  for (const contractor of inputs.contractors) {
    // With buildings chosen, a building's coverage plan decides (for the chosen trades, if any); with trades alone, the contractor's own list does.
    if (request.buildingIds.length > 0) {
      if (!inputs.assignedAtBuildings.has(contractor.contractorId)) continue;
    } else {
      const trades = inputs.profiles.get(contractor.contractorId) ?? [];
      if (!request.trades.some((wanted) => trades.some((trade) => same(trade, wanted)))) continue;
    }
    const found = fromField(contractor.email, "contractor", contractor.name, (address, single) => ({
      address,
      description: contractor.name,
      mergeValues: {},
      name: single ? contractor.contactName ?? contractor.name : null,
      recipientRefId: String(contractor.contractorId),
      recipientType: "contractor",
    }));
    out.candidates.push(...found.candidates);
    out.excluded.push(...found.excluded);
  }
  return out;
}

export function resolveStaff(staff: readonly StaffRow[]): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  for (const person of staff) {
    const found = fromField(person.email, "staff", `${person.name}, ${person.role.replace(/_/g, " ")}`, (address) => ({
      address,
      description: `${person.name}, ${person.role.replace(/_/g, " ")}`,
      mergeValues: {},
      name: person.name,
      recipientRefId: String(person.userId),
      recipientType: "staff",
    }));
    out.candidates.push(...found.candidates);
    out.excluded.push(...found.excluded);
  }
  return out;
}

export function resolveTyped(typed: readonly string[]): Outcome {
  const out: Outcome = { candidates: [], excluded: [] };
  for (const raw of typed) {
    const { invalid, valid } = addressesIn(raw);
    for (const address of valid) out.candidates.push({ address, description: "Typed address", mergeValues: {}, name: null, recipientRefId: null, recipientType: "manual" });
    for (const bad of invalid) out.excluded.push({ address: bad, description: "Typed address", reason: "invalid_address", source: "manual" });
  }
  return out;
}

/** De-duplicates by address, keeping the candidate with the most merge values (the first wins a tie), and counts what is left. */
export function combine(outcomes: readonly Outcome[]): ResolvedAudience {
  const byAddress = new Map<string, AudienceRecipient>();
  let candidates = 0;
  for (const candidate of outcomes.flatMap((outcome) => outcome.candidates)) {
    candidates += 1;
    const key = candidate.address.toLowerCase();
    const kept = byAddress.get(key);
    if (kept === undefined) {
      byAddress.set(key, { ...candidate, sources: [candidate.recipientType] });
      continue;
    }
    const sources = kept.sources.includes(candidate.recipientType) ? kept.sources : [...kept.sources, candidate.recipientType];
    const richer = Object.keys(candidate.mergeValues).length > Object.keys(kept.mergeValues).length;
    byAddress.set(key, richer ? { ...candidate, sources: [candidate.recipientType, ...sources.filter((source) => source !== candidate.recipientType)] } : { ...kept, sources });
  }
  const recipients = [...byAddress.values()];
  const count = (type: RecipientType): number => recipients.filter((recipient) => recipient.recipientType === type).length;
  return {
    counts: { contractor: count("contractor"), duplicatesMerged: candidates - recipients.length, manual: count("manual"), staff: count("staff"), tenancy: count("tenancy"), total: recipients.length },
    excluded: outcomes.flatMap((outcome) => outcome.excluded),
    recipients,
  };
}
