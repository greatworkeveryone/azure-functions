#!/usr/bin/env node
/* eslint-disable no-console */
// npm run build && node scripts/eval-contractor-ranker.cjs [options]
//
// Offline evaluation of the contractor ranker from its own log (SC-AI3, migration
// 171): how often the contractor a person chose was in the top 1, 3 or 5 suggested
// (hit@1, hit@3, hit@5), the mean reciprocal rank, how often there was anything to
// suggest (coverage) and the counts behind them, per ranker version and feature
// schema version, with a per-context breakdown. It can also write one JSONL training
// row per contractor per answered set (features and label) for a learned ranker, and
// replay the logged sets through another ranker beside the logged result.
// The measures and their definitions are in src/contractorSuggestions/evaluation.ts.
//
// READ ONLY. The three queries below are SELECTs; nothing is written to any
// database, and a test (contractor-suggestion-append-only.test.ts) fails if this
// file ever gains a statement that writes.
//
// LOCAL BY DEFAULT. With no options it reads the local review database
// (localhost/floorplan_review, the Docker one `scripts/local-review.cjs` makes) with
// that container's own login (sa, the local-only password in local-review.cjs;
// override with SQL_USERNAME and SQL_PASSWORD). It REFUSES any server that is not
// localhost, 127.0.0.1 or ::1 unless you pass --allow-remote, which says you mean it:
// it then reads that server as you, with your `az login` token, never a stored
// password. There is no environment variable that points it elsewhere.
//
//   node scripts/eval-contractor-ranker.cjs                     report on the local review database
//   node scripts/eval-contractor-ranker.cjs --json --include-test
//   node scripts/eval-contractor-ranker.cjs --export rows.jsonl     (refuses to overwrite a file)
//   node scripts/eval-contractor-ranker.cjs --replay dist/contractorSuggestions/rulesRanker.js
//   node scripts/eval-contractor-ranker.cjs --target <server>/<database> --allow-remote
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Connection, TYPES } = require("tedious");
const { connectionFactory } = require("./lib/sql-connection.cjs");

// The local review container's login, as in scripts/local-review.cjs. Loopback only, never sent anywhere else.
const LOCAL_REVIEW_PASSWORD = "FloorplanReview2026_LocalOnly";

const FILTER = `(@IncludeTest = 1 OR s.IsTest = 0)
    AND (@Since IS NULL OR s.CreatedAt >= @Since)
    AND (@Ranker IS NULL OR s.RankerVersion = @Ranker)`;

const SETS_SQL = `SELECT s.SetId, s.CreatedAt, s.Context, s.JobId, s.BuildingId, s.Trade, s.RankerVersion, s.FeatureSchemaVersion, s.CandidateCount, s.IsTest
  FROM dbo.ContractorSuggestionSets s
  WHERE ${FILTER}
  ORDER BY s.SetId`;

const ITEMS_SQL = `SELECT i.SetId, i.ContractorId, i.[Rank], i.Score, i.FeaturesJson
  FROM dbo.ContractorSuggestionItems i
  JOIN dbo.ContractorSuggestionSets s ON s.SetId = i.SetId
  WHERE ${FILTER}
  ORDER BY i.SetId, i.[Rank]`;

const OUTCOMES_SQL = `SELECT o.SetId, o.ChosenContractorId, o.ChosenRank, o.Outcome, o.ChosenFeaturesJson
  FROM dbo.ContractorSuggestionOutcomes o
  JOIN dbo.ContractorSuggestionSets s ON s.SetId = o.SetId
  WHERE ${FILTER}
  ORDER BY o.OutcomeId`;

function load() {
  try {
    return {
      evaluation: require("../dist/contractorSuggestions/evaluation"),
      db: require("../dist/db"),
    };
  } catch (error) {
    throw new Error(`Could not load the compiled evaluation (${error.message}). Run \`npm run build\` first.`);
  }
}

function localConnection(target) {
  const host = target.server.replace(/^tcp:/i, "");
  const bracketed = host.startsWith("[");
  const [name, port] = bracketed ? [host.slice(0, host.indexOf("]") + 1), host.slice(host.indexOf("]") + 1).replace(/^[,:]/, "")] : host.split(/[,:]/);
  return () =>
    new Promise((resolve, reject) => {
      const connection = new Connection({
        server: name.replace(/^\[|\]$/g, ""),
        authentication: {
          type: "default",
          options: { userName: process.env.SQL_USERNAME || "sa", password: process.env.SQL_PASSWORD || LOCAL_REVIEW_PASSWORD },
        },
        options: { database: target.database, encrypt: true, trustServerCertificate: true, connectTimeout: 30_000, ...(port ? { port: Number(port) } : {}) },
      });
      connection.on("connect", (err) => (err ? reject(err) : resolve(connection)));
      connection.connect();
    });
}

const pct = (value) => (value === null ? "   n/a" : `${(value * 100).toFixed(1).padStart(5)}%`);
const dec = (value) => (value === null ? "  n/a" : value.toFixed(3));

function metricsLine(label, m) {
  return `  ${label.padEnd(15)} ${String(m.counts.sets).padStart(5)} ${String(m.counts.answered).padStart(8)} ${pct(m.hitAt["1"])} ${pct(m.hitAt["3"])} ${pct(m.hitAt["5"])}  ${dec(m.mrr)} ${pct(m.coverage)}`;
}

function printReport(groups) {
  const head = "                   sets answered  hit@1  hit@3  hit@5    mrr coverage";
  for (const group of groups) {
    console.log(`\n${group.rankerVersion} on ${group.featureSchemaVersion}`);
    console.log(head);
    console.log(metricsLine("all contexts", group.overall));
    for (const [context, metrics] of Object.entries(group.byContext)) console.log(metricsLine(context, metrics));
    const c = group.overall.counts;
    console.log(
      `  ${c.sets} sets: ${c.setsWithSuggestions} with suggestions, ${c.setsEmpty} empty; ${c.answered} answered, ${c.dismissed} dismissed, ${c.unanswered} with no outcome yet; ${c.choices} choices (${c.choicesSuggested} suggested, ${c.choicesOther} not)`,
    );
  }
}

function printReplay(report, version) {
  console.log(`\nReplay with ${version} over ${report.sets} answered sets (the logged candidates only; see evaluation.ts)`);
  console.log("                   sets answered  hit@1  hit@3  hit@5    mrr coverage");
  console.log(metricsLine("as logged", report.baseline));
  console.log(metricsLine(version.slice(0, 15), report.replayed));
}

async function main() {
  const { evaluation, db } = load();
  const args = evaluation.parseEvalArgs(process.argv.slice(2));
  if (args.help) {
    console.log(evaluation.EVAL_USAGE);
    return 0;
  }
  const target = evaluation.resolveEvalTarget(args);
  if (!target.isLocal) delete process.env.LOCAL_SQL; // a SQL login must never go to a remote server
  console.log(`Target: ${target.server}/${target.database} (${target.isLocal ? "local" : "REMOTE, read only, as your az login"})`);

  if (args.export && fs.existsSync(args.export)) throw new Error(`Refusing to overwrite ${args.export}`);
  let replayRanker = null;
  if (args.replay) {
    const loaded = require(path.resolve(args.replay));
    replayRanker = loaded.ranker ?? loaded.default ?? loaded.rulesRanker;
    if (!replayRanker || typeof replayRanker.rank !== "function" || typeof replayRanker.version !== "string") {
      throw new Error(`${args.replay} must export a ranker: { version, rank(candidates, context) } as \`ranker\`, the default export, or rulesRanker`);
    }
  }

  const connect = target.isLocal ? localConnection(target) : connectionFactory({ server: target.server, database: target.database });
  const connection = await connect();
  let sets;
  try {
    const params = [
      { name: "IncludeTest", type: TYPES.Bit, value: args.includeTest },
      { name: "Since", type: TYPES.DateTime2, value: args.since ? new Date(`${args.since}T00:00:00Z`) : null },
      { name: "Ranker", type: TYPES.NVarChar, value: args.ranker },
    ];
    const setRows = await db.executeQuery(connection, SETS_SQL, params);
    const itemRows = await db.executeQuery(connection, ITEMS_SQL, params);
    const outcomeRows = await db.executeQuery(connection, OUTCOMES_SQL, params);
    sets = evaluation.assembleSets(setRows, itemRows, outcomeRows);
  } finally {
    db.closeConnection(connection);
  }

  if (sets.length === 0) {
    console.log("No suggestion sets for these filters: nothing has been logged yet, or it is all test data (try --include-test).");
    return 0;
  }

  const groups = evaluation.evaluate(sets);
  const replayed = replayRanker ? await evaluation.replay(sets, replayRanker) : null;
  if (args.json) {
    console.log(JSON.stringify({ filters: { includeTest: args.includeTest, ranker: args.ranker, since: args.since }, groups, replay: replayed && { ranker: replayRanker.version, ...replayed } }, null, 2));
  } else {
    printReport(groups);
    if (replayed) printReplay(replayed, replayRanker.version);
  }

  if (args.export) {
    const rows = evaluation.trainingRows(sets);
    fs.writeFileSync(args.export, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { flag: "wx" });
    console.log(`\nWrote ${rows.length} training rows to ${args.export}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
