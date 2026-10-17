// Error text can name a company file the CFO hasn't registered: a refusal for
// the configured file before it is registered, or a path in MYOB's own words.
// The daily email never prints such an id (plan M4 final look): "company file
// {id}", "/accountright/{id}" and any bare mention of the configured file are
// replaced unless the file is registered.

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const UNREGISTERED_FILE = "a company file Floorplan isn't set up for";

export function redactUnregisteredFiles(text: string, registered: ReadonlySet<string>, knownFiles: readonly string[] = []): string {
  const keep = (id: string) => registered.has(id.toLowerCase());
  let out = text
    .replace(new RegExp(`\\bcompany file (${GUID})`, "gi"), (whole: string, id: string) => (keep(id) ? whole : UNREGISTERED_FILE))
    .replace(new RegExp(`/accountright/(${GUID})`, "gi"), (whole: string, id: string) => (keep(id) ? whole : `/accountright/(${UNREGISTERED_FILE})`));
  for (const id of knownFiles) {
    if (id && !keep(id)) out = out.replace(new RegExp(id.replace(/[^0-9a-f-]/gi, ""), "gi"), UNREGISTERED_FILE);
  }
  return out;
}
