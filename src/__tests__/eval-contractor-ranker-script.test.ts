import { readFileSync } from "node:fs";
import { join } from "node:path";

// scripts/eval-contractor-ranker.cjs reads the contractor suggestion log and
// nothing else. The maths and the target rules are tested in
// src/contractorSuggestions/evaluation.test.ts; these pin that the script itself
// cannot write, and decides where it may connect before it connects.

const SCRIPT = readFileSync(join(__dirname, "..", "..", "scripts", "eval-contractor-ranker.cjs"), "utf8");
const HEADER = SCRIPT.split('"use strict";')[0];
const CODE = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

describe("scripts/eval-contractor-ranker.cjs", () => {
  it("has no statement that writes, alters or runs anything but a SELECT", () => {
    expect(CODE).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC|EXECUTE|GRANT|REVOKE|BACKUP)\b/);
  });

  it("sends exactly three statements, each a SELECT from the log", () => {
    const statements = [...CODE.matchAll(/const (SETS|ITEMS|OUTCOMES)_SQL = `([\s\S]*?)`;/g)];
    expect(statements.map((match) => match[1])).toEqual(["SETS", "ITEMS", "OUTCOMES"]);
    for (const [, , sql] of statements) expect(sql.trim()).toMatch(/^SELECT\b/);
    expect(CODE.match(/executeQuery\(/g)).toHaveLength(3);
  });

  it("works out the target, and refuses a non-local one, before it opens any connection", () => {
    const resolve = CODE.indexOf("resolveEvalTarget(args)");
    expect(resolve).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(CODE.indexOf("await connect()"));
    expect(resolve).toBeLessThan(CODE.indexOf("connectionFactory({"));
    expect(resolve).toBeLessThan(CODE.indexOf("target.isLocal ? localConnection(target)"));
  });

  it("never sends its stored local login to a remote server", () => {
    expect(CODE).toContain("if (!target.isLocal) delete process.env.LOCAL_SQL");
    expect(CODE).toMatch(/target\.isLocal \? localConnection\(target\) : connectionFactory\(/);
  });

  it("does not read the server from an environment variable", () => {
    expect(CODE).not.toMatch(/process\.env\.SQL_SERVER|process\.env\.SQL_DATABASE/);
  });

  it("documents the localhost refusal and --allow-remote in its header", () => {
    expect(HEADER).toMatch(/READ ONLY/);
    expect(HEADER).toMatch(/localhost\/floorplan_review/);
    expect(HEADER).toMatch(/REFUSES any server that is not\s+\/\/ localhost, 127\.0\.0\.1 or ::1 unless you pass --allow-remote/);
  });

  it("does not overwrite a file it was asked to export to", () => {
    expect(CODE).toContain("Refusing to overwrite");
    expect(CODE).toContain('flag: "wx"');
  });
});
