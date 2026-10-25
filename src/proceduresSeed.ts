// Loads the procedures library's starting documents (beta sprint U4).
//
// content/procedures/*.md in the frontend are the six documents the library ships
// with. Left there, Procedures is empty for everyone the day it is switched on,
// because the library reads the database. The frontend exports them as blocks
// (exports/procedures-seed.json); this repo keeps a byte copy at
// migrations/seeding/procedures.seed.json, pinned by hash in both repos, and
// `npm run seed:procedures -- --target <server>/<database> [--apply]` loads it.
//
// Idempotent by slug and version, and it only adds. A procedure that is not in the
// library yet is inserted whole; one that already has any version is left alone,
// because once a document has been edited in the app its versions are the source of
// truth and a published version is immutable. So running it again, or after a
// document has been worked on, changes nothing. Dry run by default.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Connection, TYPES } from "tedious";
import { executeQuery } from "./db";

export const SEED_FILE = join(__dirname, "..", "migrations", "seeding", "procedures.seed.json");

export interface SeedEntry {
  approvedBy?: string;
  approvedOn?: string;
  audience: string[];
  blocks: unknown[];
  category: string;
  order: number;
  owner?: string;
  reviewDue?: string;
  slug: string;
  /** From the markdown's frontmatter: draft, published or retired. */
  status: string;
  summary: string;
  title: string;
  /** "YYYY-MM-DD". */
  updated: string;
  version: number;
}

/** What the library holds now: for each slug, the version numbers it has (empty when only the parent row exists). */
export type LibraryState = Record<string, number[]>;

export type SeedAction =
  | { createProcedure: boolean; entry: SeedEntry; kind: "insert" }
  | { kind: "skip"; reason: string; slug: string };

export interface SeedReport {
  failed: number;
  inserted: number;
  skipped: number;
  wouldInsert: number;
}

export function loadSeedEntries(file: string = SEED_FILE): SeedEntry[] {
  return JSON.parse(readFileSync(file, "utf8")) as SeedEntry[];
}

export function planSeed(entries: readonly SeedEntry[], library: LibraryState): SeedAction[] {
  return entries.map((entry): SeedAction => {
    const versions = library[entry.slug];
    if (versions === undefined) return { createProcedure: true, entry, kind: "insert" };
    if (versions.length === 0) return { createProcedure: false, entry, kind: "insert" };
    if (versions.includes(entry.version)) return { kind: "skip", reason: `version ${entry.version} is already there`, slug: entry.slug };
    return { kind: "skip", reason: "already has versions made in the app, which are the source of truth now", slug: entry.slug };
  });
}

/** Every slug in the library with its version numbers. */
export async function readLibrary(connection: Connection): Promise<LibraryState> {
  const rows = await executeQuery(
    connection,
    `SELECT p.Slug, v.VersionNo
     FROM dbo.Procedures p
     LEFT JOIN dbo.ProcedureVersions v ON v.Slug = p.Slug`,
  );
  const library: LibraryState = {};
  for (const row of rows) {
    const slug = String(row.Slug);
    library[slug] ??= [];
    if (row.VersionNo !== null && row.VersionNo !== undefined) library[slug].push(Number(row.VersionNo));
  }
  return library;
}

const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** The version row's status: the database has no "retired", an archived version is the same idea. */
function versionStatus(status: string): "archived" | "draft" | "published" {
  if (status === "published") return "published";
  if (status === "retired") return "archived";
  return "draft";
}

/**
 * One document, in one transaction, each insert guarded again in SQL so a second
 * runner cannot double it. A published version must carry an approver (the table's
 * CHECK): the markdown's own approval when it has one, otherwise its owner, said
 * to be from the repository, so the footer never claims a director signed it.
 */
export async function insertSeedEntry(connection: Connection, entry: SeedEntry): Promise<void> {
  const status = versionStatus(entry.status);
  const published = status === "published";
  const approvedBy = published ? (entry.approvedBy ?? `${entry.owner ?? "Floorplan"} (from content/procedures)`) : null;
  const approvedAt = published ? utcDate(entry.approvedOn ?? entry.updated) : null;
  await executeQuery(
    connection,
    `BEGIN TRY
       BEGIN TRANSACTION;

       IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = @Slug)
         INSERT INTO dbo.Procedures (Slug, Category, Audience, SortOrder, Owner)
         VALUES (@Slug, @Category, @Audience, @SortOrder, @Owner);

       IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = @Slug)
         INSERT INTO dbo.ProcedureVersions
           (Slug, VersionNo, Title, Summary, BlocksJson, Status, CreatedBy, CreatedAt,
            ApprovedBy, ApprovedAt, PublishedAt, ReviewDue)
         VALUES
           (@Slug, @VersionNo, @Title, @Summary, @Blocks, @Status, @CreatedBy, @CreatedAt,
            @ApprovedBy, @ApprovedAt, @PublishedAt, @ReviewDue);

       COMMIT TRANSACTION;
     END TRY
     BEGIN CATCH
       IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
       THROW;
     END CATCH`,
    [
      { name: "Slug", type: TYPES.NVarChar, value: entry.slug },
      { name: "Category", type: TYPES.NVarChar, value: entry.category },
      { name: "Audience", type: TYPES.NVarChar, value: entry.audience.join(",") },
      { name: "SortOrder", type: TYPES.Int, value: entry.order },
      { name: "Owner", type: TYPES.NVarChar, value: entry.owner ?? null },
      { name: "VersionNo", type: TYPES.Int, value: entry.version },
      { name: "Title", type: TYPES.NVarChar, value: entry.title },
      { name: "Summary", type: TYPES.NVarChar, value: entry.summary },
      { name: "Blocks", type: TYPES.NVarChar, value: JSON.stringify(entry.blocks) },
      { name: "Status", type: TYPES.NVarChar, value: status },
      { name: "CreatedBy", type: TYPES.NVarChar, value: entry.owner ?? "Seed import" },
      { name: "CreatedAt", type: TYPES.DateTime2, value: utcDate(entry.updated) },
      { name: "ApprovedBy", type: TYPES.NVarChar, value: approvedBy },
      { name: "ApprovedAt", type: TYPES.DateTime2, value: approvedAt },
      { name: "PublishedAt", type: TYPES.DateTime2, value: published ? utcDate(entry.updated) : null },
      { name: "ReviewDue", type: TYPES.Date, value: published && entry.reviewDue ? utcDate(entry.reviewDue) : null },
    ],
  );
}

export async function runSeed(
  connection: Connection,
  entries: readonly SeedEntry[],
  options: { apply: boolean; log: (line: string) => void },
): Promise<SeedReport> {
  const report: SeedReport = { failed: 0, inserted: 0, skipped: 0, wouldInsert: 0 };
  const plan = planSeed(entries, await readLibrary(connection));
  for (const action of plan) {
    if (action.kind === "skip") {
      report.skipped++;
      options.log(`  skip    ${action.slug}: ${action.reason}`);
      continue;
    }
    const { slug } = action.entry;
    if (!options.apply) {
      report.wouldInsert++;
      options.log(`  would add  ${slug} (version ${action.entry.version}, ${action.entry.status})`);
      continue;
    }
    try {
      await insertSeedEntry(connection, action.entry);
      report.inserted++;
      options.log(`  added   ${slug} (version ${action.entry.version}, ${action.entry.status})`);
    } catch (error) {
      report.failed++;
      options.log(`  FAILED  ${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
