// ─────────────────────────────────────────────────────────────────────────────
// Asset register (WP49a) - the contract, in one place, with no I/O.
//
// Roles, enums, request validators, the verification rule and row -> API
// transforms live here so the handlers stay thin and the frontend has a single
// file to mirror. Everything is camelCase on the wire; SQL columns are PascalCase.
//
// Routes (all under /api, one function per file in src/functions/):
//   GET  getLocations          ?buildingId                       view
//   POST upsertLocation        LocationInput                     edit
//   GET  getAssets             ?buildingId&category&locationId&status&verified
//                              &unclassified&includeArchived&page&pageSize   view
//   GET  getAsset              ?id                               view
//   POST upsertAsset           AssetInput                        edit
//   POST archiveAsset          { assetId }                       archive
//   POST verifyAsset           { assetId }                       edit
//   POST linkJobAsset          { jobId, assetId }                edit
//   POST unlinkJobAsset        { jobId, assetId }                edit
//   GET  getAssetAttachments   ?assetId                          view
//   POST uploadAssetAttachment multipart: file, assetId          edit
//   GET  getAssetTypes         ?category&includeInactive         view
//   POST upsertAssetType       AssetTypeInput                    manage types
// ─────────────────────────────────────────────────────────────────────────────

import { AppRole } from "./auth";
import type { SqlRow } from "./db";

// ── Roles ────────────────────────────────────────────────────────────────────
// Handlers pass these straight to requireRole. Its hierarchy also admits
// `director` through any gate that is not admin-only, and facilities_manager /
// accounts_manager wherever facilities / accounts is listed, so listing
// DIRECTOR here only states what already happens. The frontend capability map
// mirrors these lists.

/** Read assets, locations, types, attachments. Every operational role; not the baseline `user` tier. */
export const VIEW_ASSETS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

/** Create/edit assets and locations, link jobs, upload files. Field staff capture assets on walks. */
export const EDIT_ASSETS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
] as const;

/** Stamp an asset as verified (same people who can edit). */
export const VERIFY_ASSETS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
] as const;

/** Archive assets. Managers only. */
export const ARCHIVE_ASSETS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES_APPROVAL,
] as const;

/** Add/rename/retire asset types. Managers only: staff must not be able to grow the taxonomy. */
export const MANAGE_ASSET_TYPES_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES_APPROVAL,
] as const;

// ── Enumerations (mirrored by CHECK constraints in migration 113) ────────────

/**
 * The maintenance categories. Mirrors MAINTENANCE_CATEGORIES in the frontend's
 * constants/categories.ts - the backend had no list of its own. Jobs.Category is
 * free text, so this list can grow without a migration; extend both copies.
 */
export const ASSET_CATEGORIES = [
  "Fire & life safety",
  "HVAC / mechanical",
  "Hydraulic",
  "Electrical",
  "Lifts",
  "Cleaning",
  "Compliance",
  "Grounds",
  "Other",
] as const;

export const LOCATION_KINDS = ["level", "space"] as const;
export const SPACE_TYPES = [
  "tenancy",
  "common",
  "plant",
  "roof",
  "carpark",
  "external",
  "residence",
  "other",
] as const;
export const ASSET_RESPONSIBILITIES = ["owner", "tenant", "shared"] as const;
export const ASSET_STATUSES = ["active", "out_of_service", "decommissioned"] as const;
export const ASSET_CRITICALITIES = ["critical", "standard"] as const;
export const ASSET_SOURCES = ["manual", "mybuildings"] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export type LocationKind = (typeof LOCATION_KINDS)[number];
export type SpaceType = (typeof SPACE_TYPES)[number];
export type AssetResponsibility = (typeof ASSET_RESPONSIBILITIES)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type AssetCriticality = (typeof ASSET_CRITICALITIES)[number];
export type AssetSource = (typeof ASSET_SOURCES)[number];

/** Blob key prefix for asset files. cleanupAttachments must never reap it. */
export const ASSET_BLOB_PREFIX = "asset-";

/** Unique index names the handlers translate into 409s. Must match migration 113. */
export const UNIQUE_INDEXES = {
  assetExternal: "UX_Assets_Source_External",
  assetTag: "UX_Assets_Building_Tag",
  assetTypeName: "UX_AssetTypes_Category_Name",
  locationChild: "UX_Locations_Child_Name",
  locationRoot: "UX_Locations_Root_Name",
} as const;

const MAX_SPECS_JSON_CHARS = 16_000;

// ── Wire types ───────────────────────────────────────────────────────────────

export interface LocationApi {
  active: boolean;
  buildingId: number;
  kind: LocationKind;
  locationId: number;
  name: string;
  parentLocationId: number | null;
  sortOrder: number;
  spaceType: SpaceType | null;
}

export interface LocationRefApi {
  active: boolean;
  kind: LocationKind;
  locationId: number;
  name: string;
  spaceType: SpaceType | null;
}

/** Where an asset sits: the location plus its ancestors, root first. */
export interface AssetLocationApi extends LocationRefApi {
  path: LocationRefApi[];
  pathLabel: string;
}

export interface AssetTypeApi {
  active: boolean;
  assetTypeId: number;
  category: string;
  name: string;
  sortOrder: number;
}

export interface AssetApi {
  archivedAt: string | null;
  archivedBy: string | null;
  assetId: number;
  assetTag: string | null;
  assetTypeId: number | null;
  assetTypeName: string | null;
  assetTypeNote: string | null;
  buildingId: number;
  category: string;
  createdAt: string | null;
  createdBy: string | null;
  criticality: AssetCriticality;
  externalId: string | null;
  /** YYYY-MM-DD */
  installDate: string | null;
  isArchived: boolean;
  locationId: number | null;
  locationName: string | null;
  make: string | null;
  model: string | null;
  name: string;
  notes: string | null;
  parentAssetId: number | null;
  responsibility: AssetResponsibility;
  serialNumber: string | null;
  serviceContractorId: number | null;
  serviceContractorName: string | null;
  source: AssetSource;
  /** Present on single-asset responses; omitted from getAssets list items. */
  specs?: Record<string, unknown> | null;
  status: AssetStatus;
  updatedAt: string | null;
  updatedBy: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** YYYY-MM-DD */
  warrantyExpiry: string | null;
}

export interface AssetRefApi {
  assetId: number;
  assetTag: string | null;
  category: string;
  isArchived: boolean;
  name: string;
  status: AssetStatus;
}

export interface LinkedJobApi {
  isArchived: boolean;
  jobId: number;
  kind: string | null;
  linkedAt: string | null;
  linkedBy: string | null;
  status: string;
  title: string;
}

export interface AssetAttachmentApi {
  assetId: number | null;
  attachedAt: string | null;
  comment: string | null;
  contentType: string | null;
  extension: string | null;
  id: number;
  originalName: string;
  sasUrl: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
  /** Entra object id, as stored by every other attachment endpoint. */
  uploadedBy: string | null;
  /** AppUsers display name for uploadedBy, when it resolves. */
  uploadedByName: string | null;
}

export interface AssetDetailApi extends AssetApi {
  attachments: AssetAttachmentApi[];
  children: AssetRefApi[];
  linkedJobs: LinkedJobApi[];
  location: AssetLocationApi | null;
  parent: AssetRefApi | null;
  specs: Record<string, unknown> | null;
}

// ── Request types (all fields optional on the wire; see the parsers) ─────────

export interface LocationInput {
  active?: boolean;
  buildingId?: number;
  kind?: LocationKind;
  locationId?: number;
  name?: string;
  parentLocationId?: number | null;
  sortOrder?: number;
  spaceType?: SpaceType | null;
}

export interface AssetTypeInput {
  active?: boolean;
  assetTypeId?: number;
  category?: AssetCategory;
  name?: string;
  sortOrder?: number;
}

export interface AssetInput {
  assetId?: number;
  assetTag?: string | null;
  assetTypeId?: number | null;
  assetTypeNote?: string | null;
  buildingId?: number;
  category?: AssetCategory;
  criticality?: AssetCriticality;
  externalId?: string | null;
  installDate?: string | null;
  locationId?: number | null;
  make?: string | null;
  model?: string | null;
  name?: string;
  notes?: string | null;
  parentAssetId?: number | null;
  responsibility?: AssetResponsibility;
  serialNumber?: string | null;
  serviceContractorId?: number | null;
  source?: AssetSource;
  specs?: Record<string, unknown> | null;
  status?: AssetStatus;
  /** Only `true` is meaningful: stamp the asset verified by the caller in this same request. */
  verified?: boolean;
  warrantyExpiry?: string | null;
}

// ── Parsing primitives ───────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { error: string; ok: false };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (error: string): Parsed<never> => ({ error, ok: false });

type Body = Record<string, unknown>;

function readText(
  body: Body,
  key: string,
  max: number,
  nullable: boolean,
): Parsed<string | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (raw === null) return nullable ? ok(null) : fail(`${key} cannot be null`);
  if (typeof raw !== "string") return fail(`${key} must be a string`);
  const text = raw.trim();
  if (text === "") return nullable ? ok(null) : fail(`${key} cannot be empty`);
  if (text.length > max) return fail(`${key} must be at most ${max} characters`);
  return ok(text);
}

function readInteger(
  body: Body,
  key: string,
  nullable: boolean,
  min: number,
  max = 2_147_483_647,
): Parsed<number | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (raw === null) return nullable ? ok(null) : fail(`${key} cannot be null`);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    return fail(`${key} must be an integer`);
  }
  return ok(raw);
}

const readId = (body: Body, key: string, nullable: boolean) =>
  readInteger(body, key, nullable, 1);

function readEnum<T extends string>(
  body: Body,
  key: string,
  allowed: readonly T[],
  nullable: boolean,
): Parsed<T | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (raw === null) return nullable ? ok(null) : fail(`${key} cannot be null`);
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    return fail(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return ok(raw as T);
}

function readBoolean(body: Body, key: string): Parsed<boolean | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "boolean") return fail(`${key} must be true or false`);
  return ok(raw);
}

/** Maintenance category, matched case-insensitively and returned in canonical spelling. */
export function normaliseAssetCategory(raw: string): AssetCategory | null {
  const key = raw.trim().toLowerCase();
  return ASSET_CATEGORIES.find((c) => c.toLowerCase() === key) ?? null;
}

function readCategory(body: Body, key: string): Parsed<AssetCategory | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== "string") return fail(`${key} must be a string`);
  const category = normaliseAssetCategory(raw);
  if (!category) return fail(`${key} must be one of: ${ASSET_CATEGORIES.join(", ")}`);
  return ok(category);
}

/** True for a real calendar date written YYYY-MM-DD (R6: the API is ISO; the UI formats). */
export function isValidIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function readDate(body: Body, key: string): Parsed<string | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (raw === null) return ok(null);
  if (typeof raw !== "string" || !isValidIsoDate(raw.trim())) {
    return fail(`${key} must be a real date written YYYY-MM-DD`);
  }
  return ok(raw.trim());
}

function readSpecs(body: Body, key: string): Parsed<Record<string, unknown> | null | undefined> {
  const raw = body[key];
  if (raw === undefined) return ok(undefined);
  if (raw === null) return ok(null);
  if (typeof raw !== "object" || Array.isArray(raw)) return fail(`${key} must be a JSON object`);
  if (JSON.stringify(raw).length > MAX_SPECS_JSON_CHARS) {
    return fail(`${key} is too large (limit ${MAX_SPECS_JSON_CHARS} characters of JSON)`);
  }
  return ok(raw as Record<string, unknown>);
}

type FieldReader = (body: Body) => Parsed<unknown>;

/** Runs every reader; keeps only the keys the caller actually sent. */
function readFields<T>(body: Body, readers: Record<string, FieldReader>): Parsed<T> {
  const out: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(readers)) {
    const result = read(body);
    if (!result.ok) return result;
    if (result.value !== undefined) out[key] = result.value;
  }
  return ok(out as T);
}

// ── Request parsers ──────────────────────────────────────────────────────────

export function parseLocationInput(body: Body): Parsed<LocationInput> {
  return readFields<LocationInput>(body, {
    active: (b) => readBoolean(b, "active"),
    buildingId: (b) => readInteger(b, "buildingId", false, -2_147_483_648),
    kind: (b) => readEnum(b, "kind", LOCATION_KINDS, false),
    locationId: (b) => readId(b, "locationId", false),
    name: (b) => readText(b, "name", 100, false),
    parentLocationId: (b) => readId(b, "parentLocationId", true),
    sortOrder: (b) => readInteger(b, "sortOrder", false, -1_000_000, 1_000_000),
    spaceType: (b) => readEnum(b, "spaceType", SPACE_TYPES, true),
  });
}

export function parseAssetTypeInput(body: Body): Parsed<AssetTypeInput> {
  return readFields<AssetTypeInput>(body, {
    active: (b) => readBoolean(b, "active"),
    assetTypeId: (b) => readId(b, "assetTypeId", false),
    category: (b) => readCategory(b, "category"),
    name: (b) => readText(b, "name", 100, false),
    sortOrder: (b) => readInteger(b, "sortOrder", false, -1_000_000, 1_000_000),
  });
}

export function parseAssetInput(body: Body): Parsed<AssetInput> {
  return readFields<AssetInput>(body, {
    assetId: (b) => readId(b, "assetId", false),
    assetTag: (b) => readText(b, "assetTag", 40, true),
    assetTypeId: (b) => readId(b, "assetTypeId", true),
    assetTypeNote: (b) => readText(b, "assetTypeNote", 200, true),
    buildingId: (b) => readInteger(b, "buildingId", false, -2_147_483_648),
    category: (b) => readCategory(b, "category"),
    criticality: (b) => readEnum(b, "criticality", ASSET_CRITICALITIES, false),
    externalId: (b) => readText(b, "externalId", 50, true),
    installDate: (b) => readDate(b, "installDate"),
    locationId: (b) => readId(b, "locationId", true),
    make: (b) => readText(b, "make", 100, true),
    model: (b) => readText(b, "model", 100, true),
    name: (b) => readText(b, "name", 200, false),
    notes: (b) => readText(b, "notes", 2000, true),
    parentAssetId: (b) => readId(b, "parentAssetId", true),
    responsibility: (b) => readEnum(b, "responsibility", ASSET_RESPONSIBILITIES, false),
    serialNumber: (b) => readText(b, "serialNumber", 100, true),
    serviceContractorId: (b) => readId(b, "serviceContractorId", true),
    source: (b) => readEnum(b, "source", ASSET_SOURCES, false),
    specs: (b) => readSpecs(b, "specs"),
    status: (b) => readEnum(b, "status", ASSET_STATUSES, false),
    verified: (b) => readBoolean(b, "verified"),
    warrantyExpiry: (b) => readDate(b, "warrantyExpiry"),
  });
}

/** Body of archiveAsset / verifyAsset: { assetId }. */
export function parseAssetIdInput(body: Body): Parsed<{ assetId: number }> {
  const parsed = readFields<{ assetId?: number }>(body, {
    assetId: (b) => readId(b, "assetId", false),
  });
  if (!parsed.ok) return parsed;
  if (parsed.value.assetId === undefined) return fail("assetId is required");
  return ok({ assetId: parsed.value.assetId });
}

/** Body of linkJobAsset / unlinkJobAsset: { jobId, assetId }. */
export function parseJobAssetInput(body: Body): Parsed<{ assetId: number; jobId: number }> {
  const parsed = readFields<{ assetId?: number; jobId?: number }>(body, {
    assetId: (b) => readId(b, "assetId", false),
    jobId: (b) => readId(b, "jobId", false),
  });
  if (!parsed.ok) return parsed;
  const { assetId, jobId } = parsed.value;
  if (jobId === undefined) return fail("jobId is required");
  if (assetId === undefined) return fail("assetId is required");
  return ok({ assetId, jobId });
}

/** Rules that only apply when an asset is being created. Returns an error message or null. */
export function validateAssetCreate(input: AssetInput): string | null {
  if (input.buildingId === undefined) return "buildingId is required";
  if (input.name === undefined) return "name is required";
  if (input.category === undefined) return "category is required";
  const source = input.source ?? "manual";
  const externalId = input.externalId ?? null;
  if (source === "manual" && externalId !== null) {
    return "externalId only applies to imported assets (source: mybuildings)";
  }
  if (source !== "manual" && externalId === null) {
    return `externalId is required when source is ${source}`;
  }
  return null;
}

/**
 * The upsertAsset rules that need no database, so a hopeless request never opens
 * a connection. An edit (assetId) is a patch: nothing is required. Without
 * assetId and without externalId it can only be a create. With a mybuildings
 * externalId it is a create or an update - the lookup decides, and
 * validateAssetCreate runs again if the lookup finds nothing.
 */
export function precheckAssetInput(input: AssetInput): string | null {
  if (input.assetId !== undefined) return null;
  const externalId = input.externalId ?? null;
  if (externalId === null) return validateAssetCreate(input);
  if ((input.source ?? "manual") === "manual") {
    return "externalId only applies to imported assets (source: mybuildings)";
  }
  return null;
}

/** Rules that only apply to a new location. Returns an error message or null. */
export function validateLocationCreate(input: LocationInput): string | null {
  if (input.buildingId === undefined) return "buildingId is required";
  if (input.kind === undefined) return "kind is required";
  if (input.name === undefined) return "name is required";
  if (input.kind === "level") {
    if (input.parentLocationId !== undefined && input.parentLocationId !== null) {
      return "a level cannot have a parent location";
    }
    if (input.spaceType !== undefined && input.spaceType !== null) {
      return "spaceType only applies to spaces";
    }
  }
  return null;
}

// ── Verification ─────────────────────────────────────────────────────────────
// "Verified" means a person confirmed what the asset is and where it is. An
// edit that changes any of those facts voids it, unless the same request
// re-verifies. Everything else (notes, status, tag, contractor, ...) leaves the
// stamp alone.

export const VERIFICATION_IDENTITY_FIELDS = [
  "locationId",
  "category",
  "assetTypeId",
  "assetTypeNote",
  "make",
  "model",
  "serialNumber",
] as const;

export type AssetIdentity = Record<(typeof VERIFICATION_IDENTITY_FIELDS)[number], string | number | null>;

/** True when `input` sets any identity field to a value different from `current`. */
export function identityChanged(current: AssetIdentity, input: AssetInput): boolean {
  return VERIFICATION_IDENTITY_FIELDS.some((field) => {
    const next = input[field];
    return next !== undefined && next !== current[field];
  });
}

export type VerificationAction = "clear" | "keep" | "stamp";

export function resolveVerification(args: {
  identityChanged: boolean;
  isVerified: boolean;
  requested: boolean;
}): VerificationAction {
  if (args.requested) return "stamp";
  if (args.isVerified && args.identityChanged) return "clear";
  return "keep";
}

// ── Query-string and SQL-error helpers ───────────────────────────────────────

export function parseQueryInt(raw: string | null, name: string): Parsed<number | undefined> {
  if (raw === null || raw === "") return ok(undefined);
  if (!/^-?\d+$/.test(raw.trim())) return fail(`${name} must be an integer`);
  return ok(Number(raw.trim()));
}

export function parseQueryBool(raw: string | null, name: string): Parsed<boolean | undefined> {
  if (raw === null || raw === "") return ok(undefined);
  const value = raw.trim().toLowerCase();
  if (value === "true") return ok(true);
  if (value === "false") return ok(false);
  return fail(`${name} must be true or false`);
}

/** Name of the unique index/constraint behind a duplicate-key error, or null for any other error. */
export function uniqueViolationName(error: unknown): string | null {
  const e = error as { message?: unknown; number?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  const isDuplicate =
    e?.number === 2601 || e?.number === 2627 || /cannot insert duplicate key/i.test(message);
  if (!isDuplicate) return null;
  const match = message.match(/(?:unique index|constraint) '([^']+)'/i);
  return match ? match[1] : "";
}

// ── Row -> API transforms ────────────────────────────────────────────────────

const toIso = (value: unknown): string | null =>
  value ? new Date(value as Date).toISOString() : null;
const toIsoDate = (value: unknown): string | null => {
  const iso = toIso(value);
  return iso ? iso.slice(0, 10) : null;
};
const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function parseSpecs(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A hand-edited bad value renders as "no specs" rather than failing the list.
    return null;
  }
}

export function locationRowToApi(row: SqlRow): LocationApi {
  return {
    active: Boolean(row.Active),
    buildingId: Number(row.BuildingId),
    kind: row.Kind as LocationKind,
    locationId: Number(row.LocationId),
    name: String(row.Name),
    parentLocationId: numberOrNull(row.ParentLocationId),
    sortOrder: Number(row.SortOrder),
    spaceType: (row.SpaceType ?? null) as SpaceType | null,
  };
}

export function assetTypeRowToApi(row: SqlRow): AssetTypeApi {
  return {
    active: Boolean(row.Active),
    assetTypeId: Number(row.AssetTypeId),
    category: String(row.Category),
    name: String(row.Name),
    sortOrder: Number(row.SortOrder),
  };
}

export function assetRowToApi(row: SqlRow): AssetApi {
  const api: AssetApi = {
    archivedAt: toIso(row.ArchivedAt),
    archivedBy: textOrNull(row.ArchivedBy),
    assetId: Number(row.AssetId),
    assetTag: textOrNull(row.AssetTag),
    assetTypeId: numberOrNull(row.AssetTypeId),
    assetTypeName: textOrNull(row.AssetTypeName),
    assetTypeNote: textOrNull(row.AssetTypeNote),
    buildingId: Number(row.BuildingId),
    category: String(row.Category),
    createdAt: toIso(row.CreatedAt),
    createdBy: textOrNull(row.CreatedBy),
    criticality: row.Criticality as AssetCriticality,
    externalId: textOrNull(row.ExternalId),
    installDate: toIsoDate(row.InstallDate),
    isArchived: Boolean(row.ArchivedAt),
    locationId: numberOrNull(row.LocationId),
    locationName: textOrNull(row.LocationName),
    make: textOrNull(row.Make),
    model: textOrNull(row.Model),
    name: String(row.Name),
    notes: textOrNull(row.Notes),
    parentAssetId: numberOrNull(row.ParentAssetId),
    responsibility: row.Responsibility as AssetResponsibility,
    serialNumber: textOrNull(row.SerialNumber),
    serviceContractorId: numberOrNull(row.ServiceContractorId),
    serviceContractorName: textOrNull(row.ServiceContractorName),
    source: row.Source as AssetSource,
    status: row.Status as AssetStatus,
    updatedAt: toIso(row.UpdatedAt),
    updatedBy: textOrNull(row.UpdatedBy),
    verifiedAt: toIso(row.VerifiedAt),
    verifiedBy: textOrNull(row.VerifiedBy),
    warrantyExpiry: toIsoDate(row.WarrantyExpiry),
  };
  // List queries leave the (large) Specs column out; keep the key absent there.
  if (row.Specs !== undefined) api.specs = parseSpecs(row.Specs);
  return api;
}

/** The identity fields of a stored asset row, for the verification rule. */
export function assetIdentityFromRow(row: SqlRow): AssetIdentity {
  return {
    assetTypeId: numberOrNull(row.AssetTypeId),
    assetTypeNote: textOrNull(row.AssetTypeNote),
    category: String(row.Category),
    locationId: numberOrNull(row.LocationId),
    make: textOrNull(row.Make),
    model: textOrNull(row.Model),
    serialNumber: textOrNull(row.SerialNumber),
  };
}

export function assetRefRowToApi(row: SqlRow): AssetRefApi {
  return {
    assetId: Number(row.AssetId),
    assetTag: textOrNull(row.AssetTag),
    category: String(row.Category),
    isArchived: Boolean(row.ArchivedAt),
    name: String(row.Name),
    status: row.Status as AssetStatus,
  };
}

export function linkedJobRowToApi(row: SqlRow): LinkedJobApi {
  return {
    isArchived: Boolean(row.IsArchived),
    jobId: Number(row.JobID),
    kind: textOrNull(row.Kind),
    linkedAt: toIso(row.LinkedAt),
    linkedBy: textOrNull(row.LinkedBy),
    status: String(row.Status),
    title: String(row.Title),
  };
}

function locationRefFromRow(row: SqlRow): LocationRefApi {
  return {
    active: Boolean(row.Active),
    kind: row.Kind as LocationKind,
    locationId: Number(row.LocationId),
    name: String(row.Name),
    spaceType: (row.SpaceType ?? null) as SpaceType | null,
  };
}

/** `chain` is the location's ancestry from the root down to the location itself. */
export function locationChainToApi(chain: SqlRow[]): AssetLocationApi | null {
  if (chain.length === 0) return null;
  const path = chain.map(locationRefFromRow);
  return { ...path[path.length - 1], path, pathLabel: path.map((p) => p.name).join(" / ") };
}

/** `sasUrl` is minted by the caller (null when the blob is gone). */
export function attachmentRowToApi(row: SqlRow, sasUrl: string | null): AssetAttachmentApi {
  return {
    assetId: numberOrNull(row.AssetId),
    attachedAt: toIso(row.AttachedAt),
    comment: textOrNull(row.Comment),
    contentType: textOrNull(row.ContentType),
    extension: textOrNull(row.Extension),
    id: Number(row.Id),
    originalName: String(row.OriginalName),
    sasUrl,
    sizeBytes: numberOrNull(row.SizeBytes),
    uploadedAt: toIso(row.UploadedAt),
    uploadedBy: textOrNull(row.UploadedBy),
    uploadedByName: textOrNull(row.UploadedByName),
  };
}
