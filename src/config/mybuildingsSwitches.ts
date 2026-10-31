// The two switches that let Floorplan leave myBuildings for work requests
// (tenant-requests TR6). Read here and nowhere else, at call time, so a test or
// an operator changing a setting takes effect without a restart.
//
//   MYBUILDINGS_PUSH_ENABLED  "false" stops every create/update/attachment push
//     to myBuildings; requests and attachments then stay Floorplan-native.
//     Anything else (including unset) keeps today's behaviour.
//   MYBUILDINGS_SYNC_MODE     normal (default) | read_only | off.
//     read_only: the pull may insert/update local rows, nothing is written
//     upstream. off: nothing calls the myBuildings work-request API.
//     An unrecognised value fails safe to off, never to normal.

export type SyncMode = "normal" | "read_only" | "off";

export interface MyBuildingsSwitches {
  mayPull: boolean;
  mayPush: boolean;
  pushEnabled: boolean;
  syncMode: SyncMode;
  syncModeRaw: string | null;
}

type Env = Record<string, string | undefined>;

export function pushEnabled(env: Env = process.env): boolean {
  return env.MYBUILDINGS_PUSH_ENABLED?.trim().toLowerCase() !== "false";
}

export function syncMode(env: Env = process.env): SyncMode {
  const raw = env.MYBUILDINGS_SYNC_MODE?.trim().toLowerCase();
  if (!raw) return "normal";
  return raw === "normal" || raw === "read_only" || raw === "off" ? raw : "off";
}

/** Whether anything may read work requests from myBuildings. */
export function mayPullWorkRequests(env: Env = process.env): boolean {
  return syncMode(env) !== "off";
}

/** Whether anything may write a work request or attachment to myBuildings. */
export function mayPushWorkRequests(env: Env = process.env): boolean {
  return pushEnabled(env) && syncMode(env) === "normal";
}

export function currentSwitches(env: Env = process.env): MyBuildingsSwitches {
  return {
    mayPull: mayPullWorkRequests(env),
    mayPush: mayPushWorkRequests(env),
    pushEnabled: pushEnabled(env),
    syncMode: syncMode(env),
    syncModeRaw: env.MYBUILDINGS_SYNC_MODE?.trim() || null,
  };
}

export class MyBuildingsSwitchedOffError extends Error {
  constructor(what: "pull" | "push") {
    super(
      what === "pull"
        ? "myBuildings work-request sync is off (MYBUILDINGS_SYNC_MODE)"
        : "Pushing to myBuildings is switched off (MYBUILDINGS_PUSH_ENABLED / MYBUILDINGS_SYNC_MODE)",
    );
    this.name = "MyBuildingsSwitchedOffError";
  }
}
