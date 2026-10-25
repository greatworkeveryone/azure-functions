#!/usr/bin/env node
/*
 * check-routes.cjs - lists every app.http registration under src/functions with
 * its HTTP methods, route and the roles its handler enforces, and exits 1 when
 * a route has no role check and is not on the PUBLIC_ROUTES list below.
 *
 *   node scripts/check-routes.cjs            table + summary, exit 1 on a gap
 *   node scripts/check-routes.cjs --json     machine-readable list (for the
 *                                            frontend's check-api-calls.cjs)
 *   node scripts/check-routes.cjs --root DIR check another checkout
 *
 * Routes are relative to the host's /api prefix (route defaults to the function
 * name, as in the Functions v4 model). A role check is a call to requireRole()
 * reachable from the handler through local or relatively imported functions.
 * The frontend/backend comparison lives in the frontend repo:
 * scripts/check-api-calls.cjs --backend <this checkout>.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

// Routes that are deliberately reachable without a role. Keep this short; every
// entry needs the reason the route is safe without one.
const PUBLIC_ROUTES = {
  corsOptions: "CORS preflight; returns headers only",
  graphNotification: "Microsoft Graph webhook; callers must present the shared clientState secret (timing-safe compare)",
  health: "shallow probe returns {ok:true}; ?deep=true requires the admin role inside the handler",
  myobAuthCallback: "OAuth redirect driven by MYOB; the signed state parameter (10 min TTL) is verified before anything is stored",
  registerSelf: "verified Entra token (signature checked) and rate limited; links or creates only the caller's own AppUsers row, which is how a user obtains a role at all",
};

const HTTP_REGISTRARS = new Set(["http"]);
const MAX_DEPTH = 6;

function parseFile(file) {
  const text = fs.readFileSync(file, "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function stringValue(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function propName(prop) {
  if (!prop.name) return null;
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
  return null;
}

/** Top-level functions and constants of a file, by name. */
function topLevel(sf) {
  const functions = new Map();
  const consts = new Map();
  const imports = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) functions.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          functions.set(d.name.text, d.initializer);
        } else {
          consts.set(d.name.text, d.initializer);
        }
      }
    }
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const spec = stringValue(st.moduleSpecifier);
      if (!spec || !spec.startsWith(".")) continue;
      for (const el of st.importClause.namedBindings.elements) {
        imports.set(el.name.text, { spec, exported: (el.propertyName || el.name).text });
      }
    }
  }
  return { functions, consts, imports };
}

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function createAnalyzer() {
  const cache = new Map();
  function load(file) {
    if (!cache.has(file)) {
      const sf = parseFile(file);
      cache.set(file, { sf, ...topLevel(sf) });
    }
    return cache.get(file);
  }
  return { load };
}

/** A top-level const's initializer by name, in this module or the one it is imported from. */
function constOf(analyzer, file, name) {
  const mod = analyzer.load(file);
  if (mod.consts.has(name)) return { file, node: mod.consts.get(name) };
  if (mod.imports.has(name)) {
    const imp = mod.imports.get(name);
    const target = resolveModule(file, imp.spec);
    const other = target && analyzer.load(target);
    if (other && other.consts.has(imp.exported)) return { file: target, node: other.consts.get(imp.exported) };
  }
  return null;
}

/**
 * Role names from a requireRole() allowed-roles argument, following constants,
 * spreads and parameters (a helper such as authorize(request, roles) passes the
 * caller's list through). `bindings` maps a parameter name to the call-site
 * argument it received.
 */
function rolesOf(analyzer, file, arg, bindings = new Map(), depth = 0) {
  if (!arg || depth > MAX_DEPTH) return ["?"];
  let node = arg;
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) {
    if (bindings.has(node.text)) {
      const bound = bindings.get(node.text);
      return rolesOf(analyzer, bound.file, bound.node, bound.bindings, depth + 1);
    }
    const mod = analyzer.load(file);
    if (mod.consts.has(node.text)) return rolesOf(analyzer, file, mod.consts.get(node.text), new Map(), depth + 1);
    if (mod.imports.has(node.text)) {
      const imp = mod.imports.get(node.text);
      const target = resolveModule(file, imp.spec);
      const other = target && analyzer.load(target);
      if (other && other.consts.has(imp.exported)) return rolesOf(analyzer, target, other.consts.get(imp.exported), new Map(), depth + 1);
    }
    return ["?"];
  }
  // A gate read from a table, e.g. ACTION_ROLES.createQuote.gate (src/action-roles.ts):
  // follow the base constant into its object literal, property by property.
  if (ts.isPropertyAccessExpression(node)) {
    const path = [];
    let base = node;
    while (ts.isPropertyAccessExpression(base)) {
      path.unshift(base.name.text);
      base = base.expression;
    }
    if (ts.isIdentifier(base)) {
      const found = constOf(analyzer, file, base.text);
      let value = found && found.node;
      for (const key of path) {
        while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(value)))) {
          value = value.expression;
        }
        if (!value || !ts.isObjectLiteralExpression(value)) { value = null; break; }
        const prop = value.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === key);
        value = prop ? prop.initializer : null;
      }
      if (value) return rolesOf(analyzer, found.file, value, new Map(), depth + 1);
    }
    return ["?"];
  }
  if (ts.isCallExpression(node)) {
    const text = node.expression.getText();
    // Object.values(AppRole) is every role: the check only keeps out callers with no role.
    if (text === "Object.values" && node.arguments[0] && node.arguments[0].getText() === "AppRole") return ["ANY_ROLE"];
    return [`computed:${text}()`];
  }
  if (!ts.isArrayLiteralExpression(node)) return ["?"];
  const roles = [];
  for (const el of node.elements) {
    if (ts.isPropertyAccessExpression(el)) roles.push(el.name.text);
    else if (ts.isSpreadElement(el)) roles.push(...rolesOf(analyzer, file, el.expression, bindings, depth + 1));
    else roles.push("?");
  }
  return roles;
}

/**
 * Walks a handler expression and everything it calls that can be resolved, and
 * returns the union of roles passed to requireRole(), or null when none is
 * reachable. `unresolved` collects handler names that could not be located.
 */
function findRoles(analyzer, file, expr, state = { seen: new Set(), roles: null, inline: false, unresolved: [] }, depth = 0, bindings = new Map()) {
  const mod = analyzer.load(file);

  // Descends into a resolvable function. `call` is the call expression when the
  // function is invoked, so its parameters can be bound to the arguments.
  const visitFunction = (fnFile, name, node, call) => {
    if (depth > MAX_DEPTH) return;
    const inner = new Map();
    if (call && node.parameters) {
      node.parameters.forEach((param, i) => {
        if (ts.isIdentifier(param.name) && call.arguments[i]) {
          inner.set(param.name.text, { file, node: call.arguments[i], bindings });
        }
      });
    }
    // The same function reached with different arguments can carry different
    // roles, so the visit key includes the argument text.
    const key = `${fnFile}#${name}#${call ? call.arguments.map((a) => a.getText()).join(",") : ""}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    findRoles(analyzer, fnFile, node, state, depth + 1, inner);
  };

  const walk = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === "requireRole") {
          state.roles = state.roles || new Set();
          for (const r of rolesOf(analyzer, file, node.arguments[1], bindings)) state.roles.add(r);
        } else if (callee.text === "rolesForRequest") {
          // Roles read and compared inline instead of through requireRole().
          state.inline = true;
        } else if (mod.functions.has(callee.text)) {
          visitFunction(file, callee.text, mod.functions.get(callee.text), node);
        } else if (mod.imports.has(callee.text)) {
          const imp = mod.imports.get(callee.text);
          const target = resolveModule(file, imp.spec);
          if (target) {
            const other = analyzer.load(target);
            if (other.functions.has(imp.exported)) {
              visitFunction(target, imp.exported, other.functions.get(imp.exported), node);
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };

  if (ts.isIdentifier(expr)) {
    if (mod.functions.has(expr.text)) {
      visitFunction(file, expr.text, mod.functions.get(expr.text));
    } else if (mod.imports.has(expr.text)) {
      const imp = mod.imports.get(expr.text);
      const target = resolveModule(file, imp.spec);
      const other = target && analyzer.load(target);
      if (other && other.functions.has(imp.exported)) {
        visitFunction(target, imp.exported, other.functions.get(imp.exported));
      } else {
        state.unresolved.push(expr.text);
      }
    } else {
      state.unresolved.push(expr.text);
    }
  } else {
    // inline function, or a wrapper call such as withX(handler): walk it, and
    // resolve any identifier passed as an argument.
    walk(expr);
    if (ts.isCallExpression(expr)) {
      for (const arg of expr.arguments) {
        if (ts.isIdentifier(arg)) findRoles(analyzer, file, arg, state, depth + 1);
      }
    }
  }
  return state;
}

/** Every app.http(name, options) registration in one file. */
function registrationsIn(analyzer, file) {
  const mod = analyzer.load(file);
  const out = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app" &&
      HTTP_REGISTRARS.has(node.expression.name.text)
    ) {
      const name = stringValue(node.arguments[0]);
      let options = node.arguments[1];
      if (options && ts.isIdentifier(options) && mod.consts.has(options.text)) options = mod.consts.get(options.text);
      if (name && options && ts.isObjectLiteralExpression(options)) {
        const reg = { name, file, line: mod.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, methods: [], route: name, handlerExpr: null, authLevel: null };
        for (const prop of options.properties) {
          const key = propName(prop);
          if (key === "methods" && ts.isPropertyAssignment(prop) && ts.isArrayLiteralExpression(prop.initializer)) {
            reg.methods = prop.initializer.elements.map(stringValue).filter(Boolean);
          } else if (key === "route" && ts.isPropertyAssignment(prop)) {
            reg.route = stringValue(prop.initializer) ?? name;
          } else if (key === "authLevel" && ts.isPropertyAssignment(prop)) {
            reg.authLevel = stringValue(prop.initializer);
          } else if (key === "handler") {
            reg.handlerExpr = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
          }
        }
        out.push(reg);
      } else if (name) {
        out.push({ name, file, line: mod.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, methods: [], route: name, handlerExpr: null, authLevel: null, unreadable: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return out;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Classify one registration: role-checked, public by design, or ungated. */
function classify(analyzer, reg, publicRoutes) {
  let roles = null;
  let inline = false;
  let note = "";
  if (reg.unreadable || !reg.handlerExpr) {
    note = "registration options could not be read";
  } else {
    const state = findRoles(analyzer, reg.file, reg.handlerExpr);
    roles = state.roles ? [...state.roles] : null;
    inline = state.inline;
    if (!roles && !inline && state.unresolved.length) note = `handler not found: ${state.unresolved.join(", ")}`;
  }
  // A listed route is public whatever its handler does on some branch.
  if (Object.prototype.hasOwnProperty.call(publicRoutes, reg.name)) {
    return { gate: "public", roles: roles || [], inline, note: publicRoutes[reg.name] };
  }
  if (roles) return { gate: "role", roles, inline, note };
  if (inline) return { gate: "role", roles: [], inline, note: "roles read with rolesForRequest() and compared inline" };
  return { gate: "none", roles: [], inline, note: note || "no requireRole() reachable from the handler" };
}

function checkRoutes(root, publicRoutes = PUBLIC_ROUTES) {
  const functionsDir = path.join(root, "src", "functions");
  const analyzer = createAnalyzer();
  const routes = [];
  for (const file of sourceFiles(functionsDir).sort()) {
    for (const reg of registrationsIn(analyzer, file)) {
      const verdict = classify(analyzer, reg, publicRoutes);
      routes.push({
        name: reg.name,
        route: reg.route,
        methods: reg.methods,
        authLevel: reg.authLevel,
        file: path.relative(root, reg.file).split(path.sep).join("/"),
        line: reg.line,
        ...verdict,
      });
    }
  }
  routes.sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
  return routes;
}

function formatTable(routes) {
  const rows = routes.map((r) => ({
    methods: r.methods.join(",") || "?",
    route: r.route,
    gate:
      r.gate === "role"
        ? [r.roles.join(" | "), r.inline ? (r.roles.length ? "+inline" : "inline only") : ""].filter(Boolean).join(" ")
        : r.gate === "public"
          ? "PUBLIC"
          : "NO ROLE CHECK",
    at: `${r.file}:${r.line}`,
  }));
  const w = (key) => Math.max(...rows.map((r) => r[key].length), key.length);
  const pad = (s, n) => s + " ".repeat(n - s.length);
  const lines = [
    `${pad("METHODS", w("methods"))}  ${pad("ROUTE", w("route"))}  ${pad("ROLES", w("gate"))}  SOURCE`,
    ...rows.map((r) => `${pad(r.methods, w("methods"))}  ${pad(r.route, w("route"))}  ${pad(r.gate, w("gate"))}  ${r.at}`),
  ];
  return lines.join("\n");
}

function summary(routes) {
  const gated = routes.filter((r) => r.gate === "role").length;
  const open = routes.filter((r) => r.gate === "public").length;
  const none = routes.filter((r) => r.gate === "none").length;
  const inline = routes.filter((r) => r.gate === "role" && r.inline && r.roles.length === 0).length;
  return `${routes.length} http routes: ${gated} role-checked (${inline} only through an inline rolesForRequest comparison, worth a human look), ${open} public by design, ${none} without a role check`;
}

function main(argv) {
  const rootIdx = argv.indexOf("--root");
  const root = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : path.join(__dirname, ".."));
  const routes = checkRoutes(root);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ routes }, null, 2)}\n`);
  } else {
    console.log(formatTable(routes));
    const open = routes.filter((r) => r.gate === "public");
    if (open.length) {
      console.log("\nPublic by design (PUBLIC_ROUTES):");
      for (const r of open) console.log(`  ${r.name}: ${r.note}`);
    }
    console.log(`\n${summary(routes)}`);
  }
  const gaps = routes.filter((r) => r.gate === "none");
  if (gaps.length) {
    console.error(
      `\n${gaps.length} route(s) have no role check. Add requireRole(), or list the route in PUBLIC_ROUTES in scripts/check-routes.cjs with the reason it is safe:\n` +
        gaps.map((g) => `  ${g.methods.join(",")} ${g.route}  ${g.file}:${g.line}  ${g.note}`).join("\n"),
    );
    return 1;
  }
  return 0;
}

module.exports = { checkRoutes, classify, createAnalyzer, formatTable, PUBLIC_ROUTES, registrationsIn, summary };

// exitCode, not process.exit(): exit would cut piped output (--json) at the 64 KB pipe buffer.
if (require.main === module) process.exitCode = main(process.argv.slice(2));
