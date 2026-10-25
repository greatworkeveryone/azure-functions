// ESLint flat config. The headline check is the custom rule
// `local/no-sql-interpolation` — a tripwire against future SQL injection
// regressions. See eslint-rules/no-sql-interpolation.js for details.

const tsParser = require("@typescript-eslint/parser");
const noSqlInterpolation = require("./eslint-rules/no-sql-interpolation.js");

module.exports = [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      local: {
        rules: {
          "no-sql-interpolation": noSqlInterpolation,
        },
      },
    },
    rules: {
      // ── No stray console output ────────────────────────────────────────
      // Sentry captures errors; context.log (Azure Functions logger) writes
      // to App Insights. Direct console.* should be gone from prod code so
      // we never leak data into worker logs without going through either.
      "no-console": ["error", { allow: ["warn", "error"] }],
      // The allowed symbols below are the complete list of names the rule
      // will treat as "already trusted". Each one is either:
      //   - a server-constructed SQL fragment built from allowlisted
      //     column names (e.g. workRequestSelectColumns()),
      //   - a fragment composed of string literals (e.g. whereParts,
      //     insertCols, insertVals, updates, updateSet, unlinkedClause),
      //   - an id list coerced to integers from DB-derived values (idList),
      //   - a property on a server-controlled spec const (PO_JOIN / QUOTE_JOIN):
      //     spec.table, spec.parentColumn.
      // Adding to this list is a security review. Justify in the PR.
      "local/no-sql-interpolation": [
        "error",
        {
          allowIdentifiers: [
            "setClause",
            "where",
            "whereParts",
            "insertCols",
            "insertVals",
            "updates",
            "updateSet",
            "unlinkedClause",
            "idList",
            // List/search endpoints: WHERE fragments assembled only from literal
            // `Col = @param` strings (values bound via the params array), a
            // `TOP <const>` clause, and `@paramName` placeholder lists for
            // `IN (...)`. No user value ever reaches the SQL text — verified by a
            // security audit (2026-07) across inspections / keys / planner /
            // workRequests / quotes / invoices / jobs. See PR discussion.
            "whereSql",
            "whereSqlA",
            "whereSqlB",
            "topClause",
            "paginationSuffix",
            "placeholders",
            "idParamList",
          ],
          allowFunctionCalls: [
            "workRequestSelectColumns",
            // Array .join(...) of fragments composed from literal column
            // strings — the fragments themselves are safe by construction.
            "join",
            // Returns " OFFSET <int> ROWS FETCH NEXT <int> ROWS ONLY" built from
            // server-clamped integers only (see pagination.ts).
            "paginationSqlSuffix",
          ],
        },
      ],
    },
  },
  {
    // The custom rule itself doesn't need to lint its own tests the same way.
    files: ["eslint-rules/**/*.js"],
    rules: {},
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  },
];
