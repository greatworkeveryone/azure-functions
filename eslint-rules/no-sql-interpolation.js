"use strict";

/**
 * no-sql-interpolation — flags `${...}` inside template literals that look
 * like SQL, unless the interpolated expression is known-safe.
 *
 * A template literal is treated as "SQL-like" when its concatenated static
 * text matches a structural SQL shape (SELECT ... FROM, UPDATE ... SET,
 * INSERT INTO, DELETE FROM, MERGE INTO, WHERE …=/IN/LIKE, VALUES(, ORDER BY,
 * GROUP BY, INNER/LEFT JOIN). Loose keyword matches aren't enough — "from"
 * shows up in log messages and URLs too often.
 *
 * An interpolation `${expr}` is allowed when:
 *   1. `expr` is an Identifier whose name is SCREAMING_SNAKE_CASE
 *      (e.g. `JOB_COLUMNS`, `PAYMENT_COLUMNS`). Convention for static
 *      column-list constants.
 *   2. `expr` is a MemberExpression whose property is SCREAMING_SNAKE_CASE.
 *   3. `expr` is an Identifier whose name is in `allowIdentifiers`.
 *   4. `expr` is a CallExpression whose callee name is in
 *      `allowFunctionCalls` (the function is asserted to return only
 *      server-controlled SQL text).
 *   5. `expr` is a MemberExpression `.setClause` — the output of our
 *      `buildUpdateSet` helper.
 *
 * Everything else is flagged. To allowlist a one-off exception with
 * explanation, use:
 *     // eslint-disable-next-line local/no-sql-interpolation -- <reason>
 *
 * Rule options (set in eslint.config.js):
 *   allowIdentifiers: string[]     (default: ["setClause"])
 *   allowFunctionCalls: string[]   (default: [])
 */

const SQL_SHAPE_RE = new RegExp(
  [
    /SELECT\b[\s\S]*?\bFROM\b/.source,
    /INSERT\s+INTO\b/.source,
    /UPDATE\s+\w+\s+SET\b/.source,
    /DELETE\s+FROM\b/.source,
    /MERGE\s+INTO\b/.source,
    /\bWHERE\s+\[?\w+\]?\s*(=|IN\b|LIKE\b|IS\b|<|>)/.source,
    /VALUES\s*\(/.source,
    /\bORDER\s+BY\b/.source,
    /\bGROUP\s+BY\b/.source,
    /\bINNER\s+JOIN\b/.source,
    /\bLEFT\s+JOIN\b/.source,
  ].join("|"),
  "i",
);

const SCREAMING_SNAKE_CASE_RE = /^[A-Z][A-Z0-9_]*$/;

function isSqlish(templateLiteral) {
  const staticText = templateLiteral.quasis
    .map((q) => q.value.cooked)
    .join(" ");
  return SQL_SHAPE_RE.test(staticText);
}

function isSafeExpression(expr, allowIdentifiers, allowFunctionCalls) {
  if (expr.type === "Identifier") {
    if (SCREAMING_SNAKE_CASE_RE.test(expr.name)) return true;
    if (allowIdentifiers.has(expr.name)) return true;
    return false;
  }
  if (expr.type === "MemberExpression" && !expr.computed) {
    if (expr.property.type !== "Identifier") return false;
    if (SCREAMING_SNAKE_CASE_RE.test(expr.property.name)) return true;
    if (expr.property.name === "setClause") return true;
    return false;
  }
  if (expr.type === "CallExpression") {
    const callee = expr.callee;
    if (callee.type === "Identifier" && allowFunctionCalls.has(callee.name)) {
      return true;
    }
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      allowFunctionCalls.has(callee.property.name)
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow interpolating untrusted values into SQL-like template literals",
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          allowIdentifiers: {
            type: "array",
            items: { type: "string" },
          },
          allowFunctionCalls: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    ],
    messages: {
      forbidden:
        "Interpolating `{{text}}` into a SQL template literal is not allowed. Use a parameterized query (pass values via executeQuery's params array), or if this is a server-controlled constant, rename to SCREAMING_SNAKE_CASE or add it to allowIdentifiers/allowFunctionCalls in eslint.config.js. For a one-off exception: // eslint-disable-next-line local/no-sql-interpolation -- <reason>",
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowIdentifiers = new Set([
      "setClause",
      ...(options.allowIdentifiers ?? []),
    ]);
    const allowFunctionCalls = new Set(options.allowFunctionCalls ?? []);

    return {
      TemplateLiteral(node) {
        if (!isSqlish(node)) return;
        for (const expr of node.expressions) {
          if (isSafeExpression(expr, allowIdentifiers, allowFunctionCalls)) {
            continue;
          }
          const sourceCode = context.sourceCode ?? context.getSourceCode();
          const text = sourceCode.getText(expr);
          context.report({
            node: expr,
            messageId: "forbidden",
            data: { text },
          });
        }
      },
    };
  },
};
