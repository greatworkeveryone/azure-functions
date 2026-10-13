// cpiAbs — ABS Data API client for the Australian CPI index (WP22).
//
// Everything here is settled by the live check recorded in
// docs/lease-ops/wp22-step0-abs-structure.md (2026-10-13). The facts the code
// depends on:
//   - Dataflow `CPI`, key MEASURE.INDEX.TSEST.REGION.FREQ. We want
//     1 (index numbers) . 10001 (all groups) . 10 (Original) . <region> . Q.
//   - REGION 50 = Australia (weighted average of the eight capitals), 7 = Darwin.
//   - One request per region. A multi-value key such as `50+7` answers HTTP 200
//     with a single observation per series, which looks like valid data.
//   - The response is SDMX-JSON 2.0. The time dimension's `values` array is NOT
//     chronological; observations are keyed by index into it.
//   - The reference base is a per-response dataset attribute (BASE_PERIOD) and
//     changes when ABS rebases, restating every historical value.
//
// parseSdmxJson2 and extractCpiSeries are pure. Only fetchCpiSeries touches the
// network, and takes its fetch/sleep as options so tests never do.

export type CpiRegion = "AUS" | "DARWIN";

export const CPI_REGIONS: readonly CpiRegion[] = ["AUS", "DARWIN"];

export const ABS_DATA_BASE_URL = "https://data.api.abs.gov.au/rest/data";
export const ABS_CPI_DATAFLOW = "CPI";
// Pinned: the bare media type currently defaults to 2.0.0 but is not promised to.
// 1.0.0 is refused (406) and `application/json` silently returns the legacy shape.
export const ABS_ACCEPT_HEADER = "application/vnd.sdmx.data+json; version=2.0.0";
export const CPI_START_PERIOD = "2000-Q1";

const ABS_REGION_CODE: Record<CpiRegion, string> = { AUS: "50", DARWIN: "7" };

const KEY_MEASURE_INDEX_NUMBERS = "1";
const KEY_INDEX_ALL_GROUPS = "10001";
const KEY_TSEST_ORIGINAL = "10";
const KEY_FREQ_QUARTERLY = "Q";

// ABS publishes a quarter about four weeks after it ends, so the newest one is
// normally one or two quarters behind the clock. Four leaves room for a late
// release without failing the sync, yet still refuses a series that stops a year
// back (a truncated response can land on any period, including a recent one).
const MAX_QUARTERS_BEHIND = 4;

// ── Errors ───────────────────────────────────────────────────────────────────

export type AbsCpiErrorKind = "http" | "network" | "timeout" | "format" | "validation";

export class AbsCpiError extends Error {
  readonly kind: AbsCpiErrorKind;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    kind: AbsCpiErrorKind,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AbsCpiError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function formatError(message: string): AbsCpiError {
  return new AbsCpiError("format", message);
}

function validationError(message: string): AbsCpiError {
  return new AbsCpiError("validation", message);
}

// ── Keys and URLs ────────────────────────────────────────────────────────────

export function buildCpiKey(region: CpiRegion): string {
  return [
    KEY_MEASURE_INDEX_NUMBERS,
    KEY_INDEX_ALL_GROUPS,
    KEY_TSEST_ORIGINAL,
    ABS_REGION_CODE[region],
    KEY_FREQ_QUARTERLY,
  ].join(".");
}

export function buildCpiDataUrl(
  region: CpiRegion,
  startPeriod: string = CPI_START_PERIOD,
): string {
  return (
    `${ABS_DATA_BASE_URL}/${ABS_CPI_DATAFLOW}/${buildCpiKey(region)}` +
    `?startPeriod=${encodeURIComponent(startPeriod)}`
  );
}

// ── Quarter arithmetic ───────────────────────────────────────────────────────

const PERIOD_PATTERN = /^(\d{4})-Q([1-4])$/;

export function isCpiPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

/** Quarters since year 0, so consecutive quarters differ by exactly 1. */
function quarterOrdinal(period: string): number {
  const parts = period.match(PERIOD_PATTERN);
  if (!parts) throw formatError(`unexpected period "${period}" (expected YYYY-Qn)`);
  return Number(parts[1]) * 4 + (Number(parts[2]) - 1);
}

function ordinalToPeriod(ordinal: number): string {
  return `${Math.floor(ordinal / 4)}-Q${(ordinal % 4) + 1}`;
}

function currentQuarterOrdinal(now: Date): number {
  return now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3);
}

// ── SDMX-JSON 2.0 ────────────────────────────────────────────────────────────

export interface SdmxCode {
  id: string;
  name: string | null;
}

export interface SdmxObservation {
  period: string;
  /** null when ABS sent the observation without a value */
  value: number | null;
}

export interface SdmxSeries {
  /** Series dimension id -> the value this series carries, e.g. REGION -> {id:"7"} */
  dimensions: Record<string, SdmxCode>;
  /** In the order ABS sent them (ascending observation index). Not chronological. */
  observations: SdmxObservation[];
}

export interface SdmxData {
  /** e.g. urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=ABS:CPI(2.0.0) */
  dataStructureUrn: string | null;
  /** Dataset-level attributes by id, e.g. BASE_PERIOD -> {id:"25", name:"Sep 2025 = 100.0"} */
  datasetAttributes: Record<string, SdmxCode>;
  series: SdmxSeries[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeErrors(errors: unknown[]): string {
  return errors
    .slice(0, 3)
    .map((e) => {
      if (isObject(e)) {
        const parts = [e.code, e.title, e.detail].filter(
          (p) => typeof p === "string" || typeof p === "number",
        );
        if (parts.length > 0) return parts.join(" ");
      }
      return JSON.stringify(e);
    })
    .join("; ");
}

function readCodes(definition: JsonObject, where: string): SdmxCode[] {
  const values = definition.values;
  if (!Array.isArray(values)) throw formatError(`${where} has no values array`);
  return values.map((v, i) => {
    if (!isObject(v) || typeof v.id !== "string") {
      throw formatError(`${where} value ${i} has no string id`);
    }
    return { id: v.id, name: typeof v.name === "string" ? v.name : null };
  });
}

function toNumberOrNull(raw: unknown, where: string): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw formatError(`${where}: non-finite value`);
    return raw;
  }
  // CPI_Q delivers numbers as strings; accept the same of CPI rather than break on it.
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw formatError(`${where}: non-numeric value ${JSON.stringify(raw)}`);
}

function readDatasetAttributes(structure: JsonObject, dataSet: JsonObject): Record<string, SdmxCode> {
  const result: Record<string, SdmxCode> = {};
  const definitions = isObject(structure.attributes) ? structure.attributes.dataSet : undefined;
  const indexes = Array.isArray(dataSet.attributes) ? dataSet.attributes : [];
  if (!Array.isArray(definitions)) return result;
  definitions.forEach((definition, i) => {
    const index = indexes[i];
    if (!isObject(definition) || typeof definition.id !== "string" || typeof index !== "number") {
      return;
    }
    const code = readCodes(definition, `dataset attribute ${definition.id}`)[index];
    if (code) result[definition.id] = code;
  });
  return result;
}

function readDataStructureUrn(dataSet: JsonObject): string | null {
  if (!Array.isArray(dataSet.links)) return null;
  for (const link of dataSet.links) {
    if (isObject(link) && link.rel === "DataStructure" && typeof link.urn === "string") {
      return link.urn;
    }
  }
  return null;
}

/**
 * Parse an SDMX-JSON 2.0 data message with observations at TIME_PERIOD (the
 * ABS default layout) into labelled series. Pure; throws AbsCpiError("format")
 * on anything that is not that shape, including SDMX-JSON 1.x and `errors`.
 */
export function parseSdmxJson2(input: unknown): SdmxData {
  if (!isObject(input)) throw formatError("response is not a JSON object");

  if (Array.isArray(input.errors) && input.errors.length > 0) {
    throw formatError(`ABS returned errors: ${describeErrors(input.errors)}`);
  }

  const data = input.data;
  if (!isObject(data)) {
    if (isObject(input.structure) || Array.isArray(input.dataSets)) {
      throw formatError(
        "response is SDMX-JSON 1.x (top-level structure/dataSets); expected 2.0 (data.structures/data.dataSets)",
      );
    }
    throw formatError("response has no data object; not SDMX-JSON 2.0");
  }

  const structure = Array.isArray(data.structures) ? data.structures[0] : undefined;
  const dataSet = Array.isArray(data.dataSets) ? data.dataSets[0] : undefined;
  if (!isObject(structure)) throw formatError("response has no data.structures[0]");
  if (!isObject(dataSet)) throw formatError("response has no data.dataSets[0]");

  const dimensions = structure.dimensions;
  if (!isObject(dimensions)) throw formatError("structure has no dimensions");
  const seriesDimensions = Array.isArray(dimensions.series) ? dimensions.series : [];
  const observationDimensions = Array.isArray(dimensions.observation)
    ? dimensions.observation
    : [];
  const timeDimension = observationDimensions[0];
  if (
    observationDimensions.length !== 1 ||
    !isObject(timeDimension) ||
    timeDimension.id !== "TIME_PERIOD"
  ) {
    throw formatError("observations are not at TIME_PERIOD (unsupported dimensionAtObservation)");
  }

  const seriesDimensionCodes = seriesDimensions.map((dimension, i) => {
    if (!isObject(dimension) || typeof dimension.id !== "string") {
      throw formatError(`series dimension ${i} has no id`);
    }
    return { id: dimension.id, codes: readCodes(dimension, `series dimension ${dimension.id}`) };
  });

  const timeValues = readCodes(timeDimension, "TIME_PERIOD").map((code) => code.id);
  if (new Set(timeValues).size !== timeValues.length) {
    throw formatError("TIME_PERIOD values contain duplicates");
  }

  const rawSeries = dataSet.series;
  if (!isObject(rawSeries)) throw formatError("dataset has no series object");

  const series: SdmxSeries[] = Object.entries(rawSeries).map(([key, entry]) => {
    const positions = key.split(":").map(Number);
    if (
      positions.length !== seriesDimensionCodes.length ||
      positions.some((p) => !Number.isInteger(p) || p < 0)
    ) {
      throw formatError(`series key "${key}" does not match ${seriesDimensionCodes.length} dimensions`);
    }
    const labels: Record<string, SdmxCode> = {};
    positions.forEach((position, i) => {
      const dimension = seriesDimensionCodes[i];
      const code = dimension.codes[position];
      if (!code) throw formatError(`series key "${key}" points past ${dimension.id} values`);
      labels[dimension.id] = code;
    });

    if (!isObject(entry) || !isObject(entry.observations)) {
      throw formatError(`series "${key}" has no observations object`);
    }
    const observations = Object.entries(entry.observations)
      .map(([observationKey, raw]) => ({ index: Number(observationKey), observationKey, raw }))
      .sort((a, b) => a.index - b.index)
      .map(({ index, observationKey, raw }) => {
        const period = timeValues[index];
        if (!Number.isInteger(index) || period === undefined) {
          throw formatError(`series "${key}" observation "${observationKey}" is outside TIME_PERIOD values`);
        }
        if (!Array.isArray(raw)) {
          throw formatError(`series "${key}" observation for ${period} is not an array`);
        }
        return { period, value: toNumberOrNull(raw[0], `series "${key}" ${period}`) };
      });

    return { dimensions: labels, observations };
  });

  return {
    dataStructureUrn: readDataStructureUrn(dataSet),
    datasetAttributes: readDatasetAttributes(structure, dataSet),
    series,
  };
}

// ── CPI series extraction ────────────────────────────────────────────────────

export interface CpiObservation {
  period: string;
  value: number;
}

export interface CpiSeries {
  region: CpiRegion;
  /** e.g. "CPI 2.0.0" (the version ABS served; just "CPI" if the response did not say) */
  dataflow: string;
  dataflowVersion: string | null;
  /** SDMX key within the dataflow, e.g. "1.10001.10.7.Q" */
  sourceKey: string;
  /** BASE_PERIOD label, e.g. "Sep 2025 = 100.0". Stored verbatim. */
  referenceBase: string;
  /** Ascending and contiguous from the requested start period. */
  observations: CpiObservation[];
}

export interface ExtractOptions {
  startPeriod?: string;
  now?: Date;
}

const URN_STRUCTURE = /=([A-Za-z0-9_]+):([A-Za-z0-9_]+)\(([^)]+)\)$/;

/**
 * Pick the one All groups / Original / Quarterly series for `region` out of a
 * parsed response and check it is a complete, current history from `startPeriod`.
 * A truncated response (the `50+7` quirk) fails here rather than being stored.
 */
export function extractCpiSeries(
  data: SdmxData,
  region: CpiRegion,
  options: ExtractOptions = {},
): CpiSeries {
  const startPeriod = options.startPeriod ?? CPI_START_PERIOD;
  const now = options.now ?? new Date();
  const sourceKey = buildCpiKey(region);

  const expected: Record<string, string> = {
    MEASURE: KEY_MEASURE_INDEX_NUMBERS,
    INDEX: KEY_INDEX_ALL_GROUPS,
    TSEST: KEY_TSEST_ORIGINAL,
    REGION: ABS_REGION_CODE[region],
    FREQ: KEY_FREQ_QUARTERLY,
  };
  const matches = data.series.filter((s) =>
    Object.entries(expected).every(([dimension, id]) => s.dimensions[dimension]?.id === id),
  );
  if (matches.length !== 1) {
    throw validationError(
      `${region}: expected exactly one series for key ${sourceKey}, found ${matches.length} ` +
        `(response carries ${data.series.length} series)`,
    );
  }

  let dataflowVersion: string | null = null;
  const urn = data.dataStructureUrn?.match(URN_STRUCTURE);
  if (urn) {
    if (urn[2] !== ABS_CPI_DATAFLOW) {
      throw validationError(`${region}: response is for ${urn[2]}, not ${ABS_CPI_DATAFLOW}`);
    }
    dataflowVersion = urn[3];
  }

  const base = data.datasetAttributes.BASE_PERIOD;
  if (!base || !base.name) {
    throw formatError(`${region}: response has no BASE_PERIOD attribute, so the index base is unknown`);
  }

  const observations: CpiObservation[] = matches[0].observations.map((o) => {
    if (o.value === null) throw validationError(`${region}: ABS sent no value for ${o.period}`);
    return { period: o.period, value: o.value };
  });
  if (observations.length === 0) throw validationError(`${region}: series has no observations`);
  observations.sort((a, b) => quarterOrdinal(a.period) - quarterOrdinal(b.period));

  const first = quarterOrdinal(observations[0].period);
  const lastPeriod = observations[observations.length - 1].period;
  if (first !== quarterOrdinal(startPeriod)) {
    throw validationError(
      `${region}: series starts at ${observations[0].period}, expected ${startPeriod} ` +
        `(${observations.length} observations; truncated response?)`,
    );
  }
  for (let i = 1; i < observations.length; i++) {
    const expectedOrdinal = first + i;
    if (quarterOrdinal(observations[i].period) !== expectedOrdinal) {
      throw validationError(
        `${region}: series is not contiguous: expected ${ordinalToPeriod(expectedOrdinal)} ` +
          `but found ${observations[i].period}`,
      );
    }
  }
  const floor = currentQuarterOrdinal(now) - MAX_QUARTERS_BEHIND;
  if (quarterOrdinal(lastPeriod) < floor) {
    throw validationError(
      `${region}: latest period ${lastPeriod} is older than ${ordinalToPeriod(floor)}; ` +
        `refusing a stale or truncated series`,
    );
  }

  return {
    region,
    dataflow: dataflowVersion ? `${ABS_CPI_DATAFLOW} ${dataflowVersion}` : ABS_CPI_DATAFLOW,
    dataflowVersion,
    sourceKey,
    referenceBase: base.name,
    observations,
  };
}

export function parseCpiResponse(
  json: unknown,
  region: CpiRegion,
  options: ExtractOptions = {},
): CpiSeries {
  return extractCpiSeries(parseSdmxJson2(json), region, options);
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export interface FetchCpiOptions extends ExtractOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Per attempt, covering the response body. Default 30 s. */
  timeoutMs?: number;
  /** Default 3. */
  maxAttempts?: number;
  /** Delay before the first retry; doubles each time. Default 1 s. */
  retryDelayMs?: number;
  onRetry?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

// 404 NoRecordsFound, 406 and 422 are deterministic: retrying cannot change them.
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestOnce(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const classify = (err: unknown): AbsCpiError =>
    controller.signal.aborted
      ? new AbsCpiError("timeout", `ABS request timed out after ${timeoutMs} ms`, {
          retryable: true,
          cause: err,
        })
      : new AbsCpiError(
          "network",
          `ABS request failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, cause: err },
        );

  try {
    let text: string;
    let status: number;
    let statusText: string;
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: ABS_ACCEPT_HEADER },
        signal: controller.signal,
      });
      status = response.status;
      statusText = response.statusText;
      text = await response.text();
    } catch (err) {
      throw classify(err);
    }

    if (status < 200 || status >= 300) {
      throw new AbsCpiError("http", `ABS responded ${status} ${statusText}: ${snippet(text)}`, {
        status,
        retryable: isRetryableStatus(status),
      });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AbsCpiError("format", `ABS response is not JSON: ${snippet(text)}`, {
        retryable: true,
        cause: err,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getJsonWithRetry(url: string, options: FetchCpiOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(url, fetchImpl, timeoutMs);
    } catch (err) {
      if (!(err instanceof AbsCpiError)) throw err;
      if (!err.retryable || attempt >= maxAttempts) throw err;
      const delay = baseDelay * 2 ** (attempt - 1);
      options.onRetry?.(
        `ABS CPI request failed (attempt ${attempt}/${maxAttempts}): ${err.message}; retrying in ${delay} ms`,
      );
      await sleep(delay);
    }
  }
}

export async function fetchCpiSeries(
  region: CpiRegion,
  options: FetchCpiOptions = {},
): Promise<CpiSeries> {
  const startPeriod = options.startPeriod ?? CPI_START_PERIOD;
  const url = buildCpiDataUrl(region, startPeriod);
  let json: unknown;
  try {
    json = await getJsonWithRetry(url, options);
  } catch (err) {
    if (err instanceof AbsCpiError) {
      throw new AbsCpiError(err.kind, `${region}: ${err.message} (${url})`, {
        status: err.status,
        retryable: err.retryable,
        cause: err,
      });
    }
    throw err;
  }
  return parseCpiResponse(json, region, { startPeriod, now: options.now });
}

/**
 * Fetch every region, one request each. All or nothing: any failure throws, and
 * the regions must agree on the reference base (a rebase caught mid-publication
 * would otherwise store a half-restated table).
 */
export async function fetchAllCpiSeries(options: FetchCpiOptions = {}): Promise<CpiSeries[]> {
  const result: CpiSeries[] = [];
  for (const region of CPI_REGIONS) {
    result.push(await fetchCpiSeries(region, options));
  }
  const bases = new Set(result.map((s) => s.referenceBase));
  if (bases.size > 1) {
    throw validationError(
      `regions disagree on the reference base: ${result
        .map((s) => `${s.region} "${s.referenceBase}"`)
        .join(", ")}`,
    );
  }
  return result;
}
