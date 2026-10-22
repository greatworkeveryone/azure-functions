// Loaded rows + an as-of date -> the Tenancy Schedule report. Pure: no database,
// no clock (the caller gives `generatedAt`). The contract is in
// command-centre .harness/TENANCY-SCHEDULE-REPORT-2026-10-22.md ("Contract (TS1-TS2)").

import { addDaysIso, addMonthsClamped } from "../darwinDate";
import type { SqlRow } from "../db";
import { parseInfoSheetSections } from "../infoSheetLogic";
import { sqlDateToIso } from "../nextReviewDate";
import { parseReliefs } from "../scheduleCharges";
import { type PendingChangeItem, pendingChangesOf } from "../scheduleChange/pending";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { scheduleTermsOf } from "../scheduleTerms";
import { parseGroups, parseMiscFees, parseSteps } from "../scheduledRateStepLogic";
import { futureReviews, leaseCharges, money, r2 } from "./charges";
import { summarise } from "./summary";
import type {
  TenancyScheduleBuilding,
  TenancyScheduleCharge,
  TenancyScheduleGap,
  TenancyScheduleGapKind,
  TenancyScheduleLease,
  TenancyScheduleNoteSection,
  TenancyScheduleResponse,
  TenancyScheduleUnit,
  TenancyScheduleVacancy,
} from "./types";

export interface TenancyScheduleData {
  buildings: SqlRow[];
  carparks: SqlRow[];
  occupancies: SqlRow[];
  pending: PendingChangeItem[];
  tenants: SqlRow[];
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A space with no tenant is a tenancy named "Vacant" (mirrors the frontend's helpers/vacantSpace.ts). */
export const isVacantSpace = (legalName: unknown): boolean => String(legalName ?? "").trim().toLowerCase() === "vacant";

/** Whole months from the first day to the lease's last day (inclusive), or null when the dates don't allow it. */
export function wholeMonthsBetween(commencement: string | null, expiry: string | null): number | null {
  if (!commencement || !expiry || expiry < commencement) return null;
  const end = addDaysIso(expiry, 1);
  let months = (Number(end.slice(0, 4)) - Number(commencement.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(commencement.slice(5, 7));
  while (months > 0 && addMonthsClamped(commencement, months) > end) months--;
  return months;
}

const byUnit = (a: TenancyScheduleUnit, b: TenancyScheduleUnit): number => collator.compare(a.level, b.level) || collator.compare(a.area, b.area);

function unitsOf(occupancies: readonly SqlRow[]): TenancyScheduleUnit[] {
  return occupancies
    .map((o): TenancyScheduleUnit => ({ area: String(o.Area ?? "").trim(), level: String(o.Level ?? "").trim(), sizeSqm: r2(num(o.SizeSqm) ?? 0) }))
    .sort(byUnit);
}

const sqmOf = (units: readonly TenancyScheduleUnit[]): number => r2(units.reduce((total, unit) => total + unit.sizeSqm, 0));

function notesOf(raw: unknown): TenancyScheduleNoteSection[] {
  return parseInfoSheetSections(typeof raw === "string" ? raw : null)
    .filter((section) => section && !section.strikethrough)
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
    .map((section) => ({
      rows: (Array.isArray(section.rows) ? section.rows : [])
        .slice()
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((row) => ({ body: text(row.body) ?? "", subheader: text(row.subheader) ?? "" }))
        .filter((row) => row.body !== "" || row.subheader !== ""),
      title: text(section.title) ?? "",
    }))
    .filter((section) => section.rows.length > 0);
}

function contactOf(row: SqlRow): TenancyScheduleLease["contact"] {
  const contact = { email: text(row.PrimaryContactEmail), name: text(row.PrimaryContactName), phone: text(row.PrimaryContactPhone) };
  return contact.email === null && contact.name === null && contact.phone === null ? null : contact;
}

/** The stored status as at `asOf`: a "current" lease past its expiry is in holdover (tenancy.ts deriveTenantStatus). */
function statusOn(stored: unknown, expiry: string | null, asOf: string): TenancyScheduleLease["status"] {
  if (stored === "pending") return "pending";
  if (stored === "holdover") return "holdover";
  return expiry !== null && expiry < asOf ? "holdover" : "current";
}

interface LeaseParts {
  bays: number;
  occupancies: readonly SqlRow[];
  pending: readonly PendingChangeItem[];
  row: SqlRow;
}

function buildLease({ bays, occupancies, pending, row }: LeaseParts, asOf: string): TenancyScheduleLease {
  const units = unitsOf(occupancies);
  const nlaSqm = sqmOf(units);
  const commencement = sqlDateToIso(row.Commencement);
  const expiry = sqlDateToIso(row.Expiry);
  const fees = parseMiscFees(text(row.MiscFees));
  const groups = parseGroups(text(row.CarparkScheduleGroups));
  const { lines, rows } = leaseCharges(
    {
      commencement,
      fallbackAnnual: num(row.RentPerAnnum) ?? 0,
      fees,
      groups,
      nlaSqm,
      reliefs: parseReliefs(text(row.RentReliefs)),
      steps: parseSteps(text(row.ScheduledRateSteps)),
      terms: scheduleTermsOf(row),
    },
    asOf,
  );
  const charges: TenancyScheduleCharge[] = lines.map((line) => ({ ...money(line.annual, nlaSqm), bays: line.bays, effectiveFrom: line.effectiveFrom, kind: line.kind, label: line.label }));
  const storedTerm = num(row.TermMonths);
  return {
    charges,
    commencement,
    contact: contactOf(row),
    expiry,
    leaseCode: text(row.IdNo),
    legalName: String(row.LegalName ?? "").trim(),
    nlaSqm,
    notes: notesOf(row.InfoSheetSections),
    optionPeriods: text(row.OptionPeriods),
    parkingBays: bays,
    pendingChanges: [...pending],
    reviews: futureReviews({
      asOf,
      cpiRegion: text(row.CpiRegion),
      expiry,
      fees,
      groups,
      pendingReviewDates: new Set(pending.filter((item) => item.kind === "rent_review" && item.from !== null).map((item) => item.from as string)),
      rows,
    }),
    scheduleSignedOff: scheduleSignOffFromRow(row) !== null,
    status: statusOn(row.Status, expiry, asOf),
    tenantId: Number(row.TenantId),
    termMonths: storedTerm !== null && storedTerm > 0 ? Math.trunc(storedTerm) : wholeMonthsBetween(commencement, expiry),
    total: money(charges.reduce((total, charge) => total + charge.annual, 0), nlaSqm),
    tradingName: text(row.TradingName),
    units,
  };
}

const firstUnit = (lease: TenancyScheduleLease): TenancyScheduleUnit | null => lease.units[0] ?? null;

function byFirstUnit(a: TenancyScheduleLease, b: TenancyScheduleLease): number {
  const x = firstUnit(a);
  const y = firstUnit(b);
  if (x && !y) return -1;
  if (!x && y) return 1;
  return (x && y ? byUnit(x, y) : 0) || collator.compare(a.legalName, b.legalName) || a.tenantId - b.tenantId;
}

function gapsOf(leases: readonly TenancyScheduleLease[]): TenancyScheduleGap[] {
  return leases.flatMap((lease): TenancyScheduleGap[] => {
    const kinds: TenancyScheduleGapKind[] = [];
    if (lease.expiry === null) kinds.push("noExpiry");
    if (lease.nlaSqm <= 0) kinds.push("noOccupancy");
    if (lease.contact === null) kinds.push("noContact");
    if (!lease.scheduleSignedOff) kinds.push("scheduleNotSignedOff");
    return kinds.length > 0 ? [{ kinds, name: lease.tradingName ?? lease.legalName, tenantId: lease.tenantId }] : [];
  });
}

const groupByNumber = <T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> => {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
};

function buildBuilding(
  building: SqlRow,
  data: { carparks: readonly SqlRow[]; occupancies: Map<number, SqlRow[]>; pending: readonly PendingChangeItem[]; tenants: readonly SqlRow[] },
  asOf: string,
): { building: TenancyScheduleBuilding; totalNla: number; vacantNla: number; bays: TenancyScheduleBuilding["summary"]["bays"] } {
  const bayCount = new Map<number, number>();
  for (const bay of data.carparks) {
    const tenantId = num(bay.TenantId);
    if (bay.AllocationKind === "tenant" && tenantId !== null) bayCount.set(tenantId, (bayCount.get(tenantId) ?? 0) + 1);
  }

  const leases: TenancyScheduleLease[] = [];
  const vacancies: TenancyScheduleVacancy[] = [];
  const vacantTenants = new Set<number>();
  let totalNla = 0;
  let letNla = 0;
  for (const row of data.tenants) {
    const tenantId = Number(row.TenantId);
    const occupancies = data.occupancies.get(tenantId) ?? [];
    if (isVacantSpace(row.LegalName) || row.Status === "vacated") {
      const units = unitsOf(occupancies);
      totalNla = r2(totalNla + sqmOf(units));
      vacantTenants.add(tenantId);
      if (units.length > 0) vacancies.push({ nlaSqm: sqmOf(units), tenantId, units });
      continue;
    }
    const lease = buildLease({ bays: bayCount.get(tenantId) ?? 0, occupancies, pending: data.pending.filter((item) => item.tenantId === tenantId), row }, asOf);
    leases.push(lease);
    totalNla = r2(totalNla + lease.nlaSqm);
    // Vacant = total less current and holdover NLA, getPortfolioOccupancy's rule.
    if (lease.status !== "pending") letNla = r2(letNla + lease.nlaSqm);
  }
  leases.sort(byFirstUnit);
  vacancies.sort((a, b) => (a.units[0] && b.units[0] ? byUnit(a.units[0], b.units[0]) : 0) || a.tenantId - b.tenantId);

  const leaseIds = new Set(leases.map((lease) => lease.tenantId));
  const bays = { leased: 0, other: 0, total: data.carparks.length, vacant: 0 };
  for (const bay of data.carparks) {
    const tenantId = num(bay.TenantId);
    if (bay.AllocationKind === "tenant" && tenantId !== null && leaseIds.has(tenantId)) bays.leased++;
    else if (bay.AllocationKind === "vacant" || (bay.AllocationKind === "tenant" && tenantId !== null && vacantTenants.has(tenantId))) bays.vacant++;
    else bays.other++;
  }
  const vacantNla = r2(totalNla - letNla);
  const id = Number(building.BuildingID);
  return {
    bays,
    building: {
      address: text(building.BuildingAddress),
      buildingId: id,
      gaps: gapsOf(leases),
      leases,
      name: String(building.BuildingName ?? "").trim(),
      pendingChangeCount: data.pending.length,
      referenceCode: text(building.ReferenceCode),
      summary: summarise({ bays, leases, totalNla, vacantNla }),
      vacancies,
    },
    totalNla,
    vacantNla,
  };
}

export interface BuildInput {
  asOf: string;
  data: TenancyScheduleData;
  generatedAt: string;
}

export function buildTenancySchedule({ asOf, data, generatedAt }: BuildInput): TenancyScheduleResponse {
  const tenantsByBuilding = groupByNumber(data.tenants, (row) => Number(row.BuildingId));
  const carparksByBuilding = groupByNumber(data.carparks, (row) => Number(row.BuildingId));
  const occupancies = groupByNumber(data.occupancies, (row) => Number(row.TenantId));
  const built = [...data.buildings]
    .sort((a, b) => collator.compare(String(a.BuildingName ?? ""), String(b.BuildingName ?? "")) || Number(a.BuildingID) - Number(b.BuildingID))
    .map((building) => {
      const id = Number(building.BuildingID);
      return buildBuilding(
        building,
        {
          carparks: carparksByBuilding.get(id) ?? [],
          occupancies,
          pending: data.pending.filter((item) => item.buildingId === id),
          tenants: tenantsByBuilding.get(id) ?? [],
        },
        asOf,
      );
    });

  const reported = new Set(built.map((entry) => entry.building.buildingId));
  const leases = built.flatMap((entry) => entry.building.leases);
  const bays = built.reduce(
    (total, entry) => ({
      leased: total.leased + entry.bays.leased,
      other: total.other + entry.bays.other,
      total: total.total + entry.bays.total,
      vacant: total.vacant + entry.bays.vacant,
    }),
    { leased: 0, other: 0, total: 0, vacant: 0 },
  );
  return {
    asOf,
    buildings: built.map((entry) => entry.building),
    generatedAt,
    // Only the buildings reported: the pending loader's "all" scope also sees residences.
    pendingChanges: pendingChangesOf(data.pending.filter((item) => item.buildingId !== null && reported.has(item.buildingId))),
    portfolio: summarise({
      bays,
      leases,
      totalNla: r2(built.reduce((total, entry) => total + entry.totalNla, 0)),
      vacantNla: r2(built.reduce((total, entry) => total + entry.vacantNla, 0)),
    }),
  };
}
