/// <reference types="jest" />
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// Handlers must not connect to SQL as the caller. Authorisation lives in
// requireRole against dbo.AppUsers; SQL grants are uniform for every user, so
// a per-caller connection buys nothing and means each new user needs a database
// principal created by hand — which 500s the entire app when missed.
// Use createRequestConnection(token) (or createServiceRequestConnection() for
// callers with no user identity, e.g. webhooks) instead. See docs/db-access.md.
//
// Scans every .ts file under src/ recursively (skipping node_modules/dist),
// not just src/functions/ — src/auth.ts, src/myob-auth.ts, src/planner.ts,
// src/email/, src/pdf/, etc. all touch the DB too. src/db.ts is the sole
// allowlisted file: it legitimately defines and uses createConnection.
describe("handlers never open a user-scoped SQL connection", () => {
  const srcDir = join(__dirname, "..");
  const ALLOWED_FILE = "db.ts";

  function walk(dir: string): string[] {
    const entries = readdirSync(dir);
    let files: string[] = [];
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist") continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        files = files.concat(walk(fullPath));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const files = walk(srcDir)
    .map((f) => relative(srcDir, f))
    .filter((f) => f !== ALLOWED_FILE);

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  // Matches createConnection(...) but NOT createRequestConnection(...),
  // createServiceConnection(...) or createServiceRequestConnection(...) — the
  // leading boundary is what excludes them, since none of those contains the
  // substring "createConnection" immediately preceded by a non-letter.
  it.each(files)("%s does not call createConnection() directly", (file) => {
    const text = readFileSync(join(srcDir, file), "utf8");
    expect(text).not.toMatch(/(?<![A-Za-z])createConnection\s*\(/);
  });

  // Catches an aliased import evading the identifier scan above, e.g.
  // `import { createConnection as foo } from "../db"` followed by `foo()`.
  it.each(files)("%s does not import createConnection from the db module", (file) => {
    const text = readFileSync(join(srcDir, file), "utf8");
    expect(text).not.toMatch(
      /import\s*\{[^}]*\bcreateConnection\b[^}]*\}\s*from\s*["'][^"']*\/db["']/,
    );
  });
});

// createServiceConnection() is the singleton tedious Connection — see
// docs/db-access.md. It's the right choice for timers and role lookups
// (keeps the DB warm, low concurrency), but a tedious Connection cannot
// serve concurrent Requests, so anything internet-reachable (an app.http
// handler) must use a fresh connection (createRequestConnection /
// createServiceRequestConnection) instead.
//
// `app.http(` presence is used as the HTTP-handler discriminator. A file
// that also registers a timer (`app.timer(`) is excluded from this check —
// the timer registration doesn't make the file's app.http handler any less
// HTTP-reachable, but distinguishing which registration a given
// createServiceConnection() call belongs to needs more than a file-level
// grep. As of this fix, no file mixes both patterns while still calling
// createServiceConnection() from its HTTP path — the excluded files
// (src/functions/parseEmails.ts, src/functions/syncAllWorkRequests.ts,
// src/functions/graphWebhook.ts) all route their app.http handlers through
// a fresh connection and only their app.timer handlers use the singleton.
describe("HTTP handlers never use the createServiceConnection() singleton", () => {
  const functionsDir = join(__dirname, "..", "functions");

  // Drops whole-line `//` comments and `/* */` blocks before matching, so a
  // comment that merely *names* createServiceConnection() (e.g. explaining
  // why a nearby call deliberately avoids it, as payments.ts does) doesn't
  // false-positive this check. Doesn't attempt to handle a trailing inline
  // comment after code on the same line — not a pattern used in this repo.
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  const httpFiles = readdirSync(functionsDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => {
      const text = readFileSync(join(functionsDir, f), "utf8");
      return /\bapp\.http\s*\(/.test(text);
    })
    .filter((f) => {
      const text = readFileSync(join(functionsDir, f), "utf8");
      return !/\bapp\.timer\s*\(/.test(text);
    });

  it("finds HTTP-handler files to check", () => {
    expect(httpFiles.length).toBeGreaterThan(20);
  });

  // Matches createServiceConnection(...) but NOT createServiceRequestConnection(...)
  // — the two identifiers don't share a suffix, so a plain identifier-boundary
  // match can't confuse them.
  it.each(httpFiles)("%s does not call createServiceConnection()", (file) => {
    const text = stripComments(readFileSync(join(functionsDir, file), "utf8"));
    expect(text).not.toMatch(/(?<![A-Za-z])createServiceConnection\s*\(/);
  });
});
