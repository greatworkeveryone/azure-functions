// Arguments and target for `npm run migrate` (scripts/migrate.cjs). The runner
// never has a default database: it runs only against a target named on the
// command line or by SQL_SERVER + SQL_DATABASE together (DL-11).

export interface MigrateArgs {
  allowDirty: boolean;
  help: boolean;
  /** "check" lists and validates (also --dry-run); "apply" applies. */
  mode: "apply" | "check";
  target: string | null;
}

export interface MigrationTarget {
  database: string;
  server: string;
  source: "--target" | "SQL_SERVER/SQL_DATABASE";
}

export const MIGRATE_USAGE = `Usage: npm run migrate -- [--dry-run | --apply] [--target <server>/<database>] [--allow-dirty]

  (no flag) / --dry-run   list pending files, check checksums, validate; changes nothing
  --apply                 apply pending files, one transaction each, under an applock
  --target s/d            the database to use; otherwise SQL_SERVER + SQL_DATABASE
  --allow-dirty           apply even when migrations/ has uncommitted changes

There is no default database. Rehearse on the restored copy first:
  npm run migrate -- --apply --target <server>.database.windows.net/free-sql-db-staging`;

export function parseMigrateArgs(argv: string[]): MigrateArgs {
  const args: MigrateArgs = { allowDirty: false, help: false, mode: "check", target: null };
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.mode = "apply";
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--allow-dirty") args.allowDirty = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--target") args.target = argv[++i] ?? "";
    else if (arg.startsWith("--target=")) args.target = arg.slice("--target=".length);
    else throw new Error(`Unknown option ${arg}\n\n${MIGRATE_USAGE}`);
  }
  if (dryRun && args.mode === "apply") throw new Error("Use either --dry-run or --apply, not both.");
  return args;
}

export function resolveMigrationTarget(
  args: Pick<MigrateArgs, "target">,
  env: Record<string, string | undefined>,
): MigrationTarget {
  if (args.target !== null) {
    const slash = args.target.lastIndexOf("/");
    const server = args.target.slice(0, slash).trim();
    const database = args.target.slice(slash + 1).trim();
    if (slash === -1 || !server || !database) {
      throw new Error(`--target must be <server>/<database>, got "${args.target}".`);
    }
    return { database, server, source: "--target" };
  }
  const server = env.SQL_SERVER?.trim();
  const database = env.SQL_DATABASE?.trim();
  if (server && database) return { database, server, source: "SQL_SERVER/SQL_DATABASE" };
  throw new Error(
    "Refusing to run without an explicit target: pass --target <server>/<database> or set both SQL_SERVER and SQL_DATABASE.",
  );
}
