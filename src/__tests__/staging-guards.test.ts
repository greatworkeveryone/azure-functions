import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Staging must not reach real email, MYOB, Teams or myBuildings (2 Nov 2026). A failure here is a stop
// sign: route the new call through the guarded file, or guard it with isStaging (src/config/stagingGuard.ts).

const SRC = join(__dirname, "..");
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
const files = sourceFiles(SRC).map((full) => ({ path: relative(SRC, full).replace(/\\/g, "/"), text: readFileSync(full, "utf8") }));
const textOf = (path: string) => files.find((f) => f.path === path)?.text ?? "";
const filesMatching = (pattern: RegExp) => files.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();

describe("outbound email goes only through the guarded files", () => {
  // Graph mail verbs: sendMail, createReply, createForward, reply, replyAll, forward, send, and draft creation.
  const SENDING = /\/sendMail\b|\/(createReply|createReplyAll|createForward)\b|\/messages\/[^`"'\s]*\/(send|reply|replyAll|forward)\b|\/users\/[^`"'\s]*\}\/messages`/;
  it("only src/graph.ts and src/comms/graphSend.ts build a Graph mail-sending URL", () => {
    expect(filesMatching(SENDING)).toEqual(["comms/graphSend.ts", "graph.ts"]);
  });
  it("both ask isStaging before any network call", () => {
    for (const path of ["graph.ts", "comms/graphSend.ts"]) {
      expect(textOf(path)).toMatch(/isStaging\(\)/);
      expect(textOf(path)).toContain("logStagingEmailSkipped");
    }
  });
  it("only the guarded files read a mailbox or subscribe to one", () => {
    expect(filesMatching(/mailFolders|graph\.microsoft\.com\/v1\.0\/subscriptions/)).toEqual(["graph.ts"]);
    expect(textOf("graph.ts")).toMatch(/assertNotStagingMailRead\(\);\s*const token/);
  });
});

describe("the mail timers, queue and webhooks skip on staging", () => {
  it.each([
    ["functions/parseEmails.ts", ["parseEmailsTimer", "parseEmailsDailyRetry", "processEmailSync", "triggerEmailParse"]],
    ["functions/graphWebhook.ts", ["graphNotification", "setupGraphSubscription", "renewGraphSubscription"]],
  ])("%s", (path, names) => {
    const text = textOf(path);
    const skips = (text.match(/skipOnStaging\(/g) ?? []).length;
    expect(skips).toBeGreaterThanOrEqual(names.length);
    for (const name of names) expect(text).toContain(name);
  });
});

describe("MYOB", () => {
  it("only myob-api-log.ts calls fetch for MYOB, and it refuses on staging before anything else", () => {
    expect(filesMatching(/api\.myob\.com|secure\.myob\.com|MYOB_API_BASE/).filter((p) => /fetch\(/.test(textOf(p)))).toEqual([]);
    const log = textOf("myob-api-log.ts");
    expect(log.indexOf("if (isStaging()) throw new MyobNotConnectedOnStagingError()")).toBeGreaterThan(-1);
    expect(log.indexOf("if (isStaging())")).toBeLessThan(log.indexOf("serialiseBody(input.body)"));
  });
  it("the request guard refuses on staging before it classifies the request", () => {
    const guard = textOf("myob-request-guard.ts");
    expect(guard.indexOf("isStaging()")).toBeGreaterThan(-1);
    expect(guard.indexOf("isStaging()")).toBeLessThan(guard.indexOf("classifyMyobRequest(input.method"));
  });
});

describe("myBuildings and Teams", () => {
  it("mayPushWorkRequests is false on staging", () => {
    expect(textOf("config/mybuildingsSwitches.ts")).toMatch(/mayPushWorkRequests[\s\S]*?if \(isStaging\(env\)\) return false/);
  });
  it("every myBuildings write is refused on staging", () => {
    expect(textOf("mybuildings-client.ts")).toMatch(/method !== "GET" && isStaging\(\)/);
  });
  it("only the guarded Teams senders post to Teams", () => {
    expect(filesMatching(/teamwork\/sendActivityNotification|workflowConfig\(/).filter((p) => /fetch\)?\(/.test(textOf(p)))).toEqual(["alerts/channel.ts", "teams/activity.ts"]);
    for (const path of ["alerts/channel.ts", "teams/activity.ts"]) expect(textOf(path)).toContain("skipOnStaging(");
  });
});
