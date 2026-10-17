import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// SEC-23: who did something is stamped from the verified token, never read
// from the request body. Fails on any handler that reads an identity field off
// the body, by property access or by destructuring. A hit is a bug; adding a
// file to the allowlist needs a written reason and a security review.

const FUNCTIONS_DIR = join(__dirname, "..", "functions");

const IDENTITY_FIELDS = [
  "CreatedBy", "UpdatedBy", "ApprovedBy", "AttachedBy", "UploadedBy", "ClaimedBy",
  "ArchivedBy", "FlaggedBy", "RejectedBy", "CompletedBy", "ValidatedBy", "UnapprovedBy",
  "UncompletedBy", "SentBy", "PaidBy", "DeletedBy", "UserId", "UserID", "Actor", "Approver",
].join("|");

const PROPERTY_READ = new RegExp(`\\bbody\\??\\.(?:${IDENTITY_FIELDS})\\b|\\bbody\\??\\.?\\[\\s*["'\`](?:${IDENTITY_FIELDS})["'\`]\\s*\\]`);
const DESTRUCTURED = new RegExp(
  `\\{[^{}]*\\b(?:${IDENTITY_FIELDS})\\b[^{}]*\\}\\s*=\\s*(?:\\(\\s*)?(?:body\\b|await\\s+request\\.json\\(\\))`,
);

const ALLOWLIST: Record<string, string> = {};

const handlerFiles = readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("no handler takes identity from the request body", () => {
  it("finds handler files to check", () => {
    expect(handlerFiles.length).toBeGreaterThan(50);
  });

  it.each(handlerFiles)("%s", (file) => {
    if (ALLOWLIST[file]) return;
    const text = readFileSync(join(FUNCTIONS_DIR, file), "utf8");
    const hits = [PROPERTY_READ, DESTRUCTURED].flatMap((re) => text.match(re) ?? []);
    expect(hits).toEqual([]);
  });

  it("would catch both shapes", () => {
    expect(PROPERTY_READ.test("const by = body?.AttachedBy ?? null;")).toBe(true);
    expect(PROPERTY_READ.test('const by = body["ApprovedBy"];')).toBe(true);
    expect(DESTRUCTURED.test("const { WorkRequestID, UpdatedBy, ...fields } = body ?? {};")).toBe(true);
    expect(DESTRUCTURED.test("const {\n  QuoteID,\n  CreatedBy,\n} = (await request.json()) as any;")).toBe(true);
    expect(DESTRUCTURED.test("const { QuoteID, Amount } = body ?? {};")).toBe(false);
  });
});
