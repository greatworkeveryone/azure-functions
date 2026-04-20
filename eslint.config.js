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
          ],
          allowFunctionCalls: [
            "workRequestSelectColumns",
            // Array .join(...) of fragments composed from literal column
            // strings — the fragments themselves are safe by construction.
            "join",
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
