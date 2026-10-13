/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABS_ACCEPT_HEADER,
  AbsCpiError,
  buildCpiDataUrl,
  buildCpiKey,
  CpiRegion,
  extractCpiSeries,
  fetchAllCpiSeries,
  fetchCpiSeries,
  parseCpiResponse,
  parseSdmxJson2,
} from "../cpiAbs";

// The fixtures are real, unmodified ABS responses saved on 2026-10-13
// (docs/lease-ops/wp22-step0-abs-structure.md). Tests pin `now` because the
// parser refuses a series that has fallen too far behind the clock.
const NOW = new Date("2026-10-13T12:00:00Z");

function fixtureText(name: string): string {
  return readFileSync(join(__dirname, "fixtures", "abs-cpi", name), "utf8");
}
const AUS_TEXT = fixtureText("cpi-2.0.0-aus-q-from-2000q1.json");
const DARWIN_TEXT = fixtureText("cpi-2.0.0-darwin-q-from-2000q1.json");
const TRUNCATED_TEXT = fixtureText("cpi-2.0.0-multi-region-truncated.json");

type Json = any;
const ausJson = (): Json => JSON.parse(AUS_TEXT);
const darwinJson = (): Json => JSON.parse(DARWIN_TEXT);

function timeIndex(json: Json, period: string): number {
  return json.data.structures[0].dimensions.observation[0].values.findIndex(
    (v: Json) => v.id === period,
  );
}
function onlySeries(json: Json): Json {
  return Object.values(json.data.dataSets[0].series)[0];
}
function valueFor(series: { observations: { period: string; value: number }[] }, period: string) {
  return series.observations.find((o) => o.period === period)?.value;
}

describe("keys and URLs", () => {
  it("builds the five-part All groups / Original / Quarterly key per region", () => {
    expect(buildCpiKey("AUS")).toBe("1.10001.10.50.Q");
    expect(buildCpiKey("DARWIN")).toBe("1.10001.10.7.Q");
  });

  it("builds one single-region URL from 2000-Q1, never a multi-value key", () => {
    expect(buildCpiDataUrl("AUS")).toBe(
      "https://data.api.abs.gov.au/rest/data/CPI/1.10001.10.50.Q?startPeriod=2000-Q1",
    );
    expect(buildCpiDataUrl("DARWIN")).toBe(
      "https://data.api.abs.gov.au/rest/data/CPI/1.10001.10.7.Q?startPeriod=2000-Q1",
    );
    expect(buildCpiDataUrl("AUS")).not.toContain("+");
    expect(buildCpiDataUrl("AUS", "2010-Q3")).toContain("startPeriod=2010-Q3");
  });

  it("pins the SDMX-JSON media type to 2.0.0", () => {
    expect(ABS_ACCEPT_HEADER).toBe("application/vnd.sdmx.data+json; version=2.0.0");
  });
});

describe("parseSdmxJson2 on the saved AUS response", () => {
  const parsed = parseSdmxJson2(ausJson());

  it("reads one labelled series with the dataset base and structure", () => {
    expect(parsed.series).toHaveLength(1);
    const dims = parsed.series[0].dimensions;
    expect(dims.MEASURE.id).toBe("1");
    expect(dims.INDEX.id).toBe("10001");
    expect(dims.TSEST.id).toBe("10");
    expect(dims.REGION).toEqual({ id: "50", name: "Australia" });
    expect(dims.FREQ.id).toBe("Q");
    expect(parsed.datasetAttributes.BASE_PERIOD).toEqual({ id: "25", name: "Sep 2025 = 100.0" });
    expect(parsed.dataStructureUrn).toMatch(/ABS:CPI\(2\.0\.0\)$/);
  });

  it("keeps ABS's non-chronological time order until the CPI layer sorts it", () => {
    const periods = parsed.series[0].observations.map((o) => o.period);
    expect(periods).toHaveLength(106);
    expect(periods).not.toEqual([...periods].sort());
  });

  it("maps observations through TIME_PERIOD values, not by position", () => {
    const series = parsed.series[0];
    const at = (period: string) => series.observations.find((o) => o.period === period)?.value;
    expect(at("2000-Q1")).toBe(48.4);
    expect(at("2025-Q3")).toBe(99.73);
    expect(at("2026-Q2")).toBe(102.31);
  });
});

describe("extractCpiSeries / parseCpiResponse on real responses", () => {
  it("returns AUS as a sorted, contiguous series with its base and source", () => {
    const series = parseCpiResponse(ausJson(), "AUS", { now: NOW });
    expect(series).toMatchObject({
      region: "AUS",
      dataflow: "CPI 2.0.0",
      dataflowVersion: "2.0.0",
      sourceKey: "1.10001.10.50.Q",
      referenceBase: "Sep 2025 = 100.0",
    });
    expect(series.observations).toHaveLength(106);
    expect(series.observations[0]).toEqual({ period: "2000-Q1", value: 48.4 });
    expect(series.observations[105]).toEqual({ period: "2026-Q2", value: 102.31 });
    const periods = series.observations.map((o) => o.period);
    expect(periods).toEqual([...periods].sort());
    expect(valueFor(series, "2025-Q4")).toBe(100.32);
  });

  it("returns Darwin from the same dataflow with its own values", () => {
    const series = parseCpiResponse(darwinJson(), "DARWIN", { now: NOW });
    expect(series).toMatchObject({
      region: "DARWIN",
      sourceKey: "1.10001.10.7.Q",
      referenceBase: "Sep 2025 = 100.0",
    });
    expect(series.observations).toHaveLength(106);
    expect(series.observations[0]).toEqual({ period: "2000-Q1", value: 51.09 });
    expect(valueFor(series, "2025-Q3")).toBe(99.66);
    expect(valueFor(series, "2026-Q2")).toBe(102.35);
  });

  it("rejects the real truncated multi-region response instead of storing one point per region", () => {
    const parsed = parseSdmxJson2(JSON.parse(TRUNCATED_TEXT));
    expect(parsed.series.map((s) => s.observations.length)).toEqual([1, 1]);
    for (const region of ["AUS", "DARWIN"] as CpiRegion[]) {
      expect(() => extractCpiSeries(parsed, region, { now: NOW })).toThrow(
        /starts at 2017-Q1, expected 2000-Q1.*truncated/,
      );
    }
  });

  it("rejects a response for a different region than requested", () => {
    expect(() => parseCpiResponse(ausJson(), "DARWIN", { now: NOW })).toThrow(
      /expected exactly one series for key 1\.10001\.10\.7\.Q, found 0/,
    );
  });

  it("rejects a series that does not start at the requested period", () => {
    expect(() => parseCpiResponse(ausJson(), "AUS", { now: NOW, startPeriod: "2001-Q1" })).toThrow(
      /starts at 2000-Q1, expected 2001-Q1/,
    );
  });

  it("rejects a series that has fallen too far behind the clock", () => {
    expect(() =>
      parseCpiResponse(ausJson(), "AUS", { now: new Date("2028-01-01T00:00:00Z") }),
    ).toThrow(/latest period 2026-Q2 is older than 2027-Q1/);
  });
});

describe("malformed responses", () => {
  it("rejects non-objects", () => {
    for (const input of ["nope", null, [], 42]) {
      expect(() => parseSdmxJson2(input)).toThrow(/not a JSON object/);
    }
  });

  it("names the legacy SDMX-JSON 1 shape", () => {
    const legacy = { header: { id: "x" }, dataSets: [{ series: {} }], structure: { dimensions: {} } };
    expect(() => parseSdmxJson2(legacy)).toThrow(/SDMX-JSON 1\.x/);
  });

  it("surfaces ABS-reported errors", () => {
    const json = { ...ausJson(), errors: [{ code: 500, title: "Boom", detail: "ABS broke" }] };
    expect(() => parseSdmxJson2(json)).toThrow(/ABS returned errors: 500 Boom ABS broke/);
  });

  it("rejects a message with no dataset", () => {
    const json = ausJson();
    json.data.dataSets = [];
    expect(() => parseSdmxJson2(json)).toThrow(/no data\.dataSets\[0\]/);
  });

  it("rejects an observation that points outside the time values", () => {
    const json = ausJson();
    onlySeries(json).observations["999"] = [1];
    expect(() => parseSdmxJson2(json)).toThrow(/outside TIME_PERIOD values/);
  });

  it("rejects duplicate TIME_PERIOD ids", () => {
    const json = ausJson();
    const values = json.data.structures[0].dimensions.observation[0].values;
    values[1].id = values[0].id;
    expect(() => parseSdmxJson2(json)).toThrow(/duplicates/);
  });

  it("rejects non-numeric observation values", () => {
    const json = ausJson();
    onlySeries(json).observations[String(timeIndex(json, "2010-Q1"))] = ["n/a"];
    expect(() => parseSdmxJson2(json)).toThrow(/non-numeric value "n\/a"/);
  });

  it("accepts numeric strings, as CPI_Q sends them", () => {
    const json = ausJson();
    const observations = onlySeries(json).observations;
    for (const key of Object.keys(observations)) observations[key] = [String(observations[key][0])];
    expect(parseCpiResponse(json, "AUS", { now: NOW })).toEqual(
      parseCpiResponse(ausJson(), "AUS", { now: NOW }),
    );
  });

  it("rejects an observation without a value rather than skipping it", () => {
    const json = ausJson();
    onlySeries(json).observations[String(timeIndex(json, "2010-Q1"))] = [null];
    expect(() => parseCpiResponse(json, "AUS", { now: NOW })).toThrow(/sent no value for 2010-Q1/);
  });

  it("rejects a gap in the history", () => {
    const json = ausJson();
    delete onlySeries(json).observations[String(timeIndex(json, "2010-Q2"))];
    expect(() => parseCpiResponse(json, "AUS", { now: NOW })).toThrow(
      /not contiguous: expected 2010-Q2 but found 2010-Q3/,
    );
  });

  it("rejects a response with no BASE_PERIOD, since the base would be unknown", () => {
    const json = ausJson();
    json.data.structures[0].attributes.dataSet = [];
    json.data.dataSets[0].attributes = [];
    expect(() => parseCpiResponse(json, "AUS", { now: NOW })).toThrow(/no BASE_PERIOD attribute/);
  });

  it("rejects the seasonally adjusted series where Original was asked for", () => {
    const json = ausJson();
    json.data.structures[0].dimensions.series[2].values[0].id = "20";
    expect(() => parseCpiResponse(json, "AUS", { now: NOW })).toThrow(
      /expected exactly one series for key 1\.10001\.10\.50\.Q, found 0/,
    );
  });

  it("rejects a response that belongs to another data structure", () => {
    const json = ausJson();
    json.data.dataSets[0].links[0].urn =
      "urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=ABS:CPI_Q(1.0.0)";
    expect(() => parseCpiResponse(json, "AUS", { now: NOW })).toThrow(/is for CPI_Q, not CPI/);
  });

  it("records the plain dataflow name when the response does not state a version", () => {
    const json = ausJson();
    json.data.dataSets[0].links = [];
    const series = parseCpiResponse(json, "AUS", { now: NOW });
    expect(series.dataflow).toBe("CPI");
    expect(series.dataflowVersion).toBeNull();
  });
});

// ── fetch ────────────────────────────────────────────────────────────────────

function reply(status: number, body: string): Response {
  return { status, statusText: status === 200 ? "OK" : "Error", text: async () => body } as unknown as Response;
}
function fetchOf(mock: jest.Mock): typeof fetch {
  return mock as unknown as typeof fetch;
}
const noSleep = jest.fn().mockResolvedValue(undefined);

beforeEach(() => {
  noSleep.mockClear();
});

describe("fetchCpiSeries", () => {
  it("makes one single-region request with the pinned Accept header", async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, DARWIN_TEXT));
    const series = await fetchCpiSeries("DARWIN", { fetchImpl: fetchOf(fetchMock), now: NOW });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(buildCpiDataUrl("DARWIN"));
    expect(init.headers).toEqual({ Accept: ABS_ACCEPT_HEADER });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(series.region).toBe("DARWIN");
    expect(series.observations).toHaveLength(106);
  });

  it("retries a 503 and a dropped connection with doubling backoff, then succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(reply(503, "upstream unavailable"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(reply(200, AUS_TEXT));
    const onRetry = jest.fn();

    const series = await fetchCpiSeries("AUS", {
      fetchImpl: fetchOf(fetchMock),
      sleepImpl: noSleep,
      onRetry,
      now: NOW,
    });

    expect(series.region).toBe("AUS");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(noSleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatch(/attempt 1\/3.*503/);
    expect(onRetry.mock.calls[1][0]).toMatch(/attempt 2\/3.*socket hang up/);
  });

  it.each([408, 425, 429, 500, 502, 504])("retries HTTP %i", async (status) => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(reply(status, "try later"))
      .mockResolvedValueOnce(reply(200, AUS_TEXT));
    await fetchCpiSeries("AUS", { fetchImpl: fetchOf(fetchMock), sleepImpl: noSleep, now: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 200 whose body is not JSON (an error page)", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(reply(200, "<html>Down for maintenance</html>"))
      .mockResolvedValueOnce(reply(200, AUS_TEXT));
    await fetchCpiSeries("AUS", { fetchImpl: fetchOf(fetchMock), sleepImpl: noSleep, now: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, "NoRecordsFound"],
    [406, "Not Acceptable"],
    [422, "Not enough key values in query, expecting 5 got 4"],
  ])("does not retry deterministic HTTP %i", async (status, body) => {
    const fetchMock = jest.fn().mockResolvedValue(reply(status, body));
    const failure = fetchCpiSeries("AUS", { fetchImpl: fetchOf(fetchMock), sleepImpl: noSleep });

    await expect(failure).rejects.toMatchObject({ kind: "http", status, retryable: false });
    await expect(failure).rejects.toThrow(new RegExp(`${status}.*${body}.*1\\.10001\\.10\\.50\\.Q`));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("gives up after the last attempt and reports the last failure", async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(503, "still down"));
    const failure = fetchCpiSeries("AUS", { fetchImpl: fetchOf(fetchMock), sleepImpl: noSleep });

    await expect(failure).rejects.toMatchObject({ kind: "http", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it("times out a request that hangs, and retries it", async () => {
    const hang = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const failure = fetchCpiSeries("AUS", {
      fetchImpl: fetchOf(hang),
      sleepImpl: noSleep,
      timeoutMs: 15,
      maxAttempts: 2,
    });

    await expect(failure).rejects.toMatchObject({ kind: "timeout", retryable: true });
    await expect(failure).rejects.toThrow(/timed out after 15 ms/);
    expect(hang).toHaveBeenCalledTimes(2);
  });

  it("does not retry a response that parses but fails validation", async () => {
    const fetchMock = jest.fn().mockResolvedValue(reply(200, TRUNCATED_TEXT));
    const failure = fetchCpiSeries("AUS", {
      fetchImpl: fetchOf(fetchMock),
      sleepImpl: noSleep,
      now: NOW,
    });

    await expect(failure).rejects.toBeInstanceOf(AbsCpiError);
    await expect(failure).rejects.toMatchObject({ kind: "validation" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAllCpiSeries", () => {
  function byRegion(darwinText: string = DARWIN_TEXT) {
    return jest.fn(async (url: string) =>
      reply(200, url.includes(".7.Q") ? darwinText : AUS_TEXT),
    );
  }

  it("requests AUS then Darwin as two separate single-region calls", async () => {
    const fetchMock = byRegion();
    const all = await fetchAllCpiSeries({ fetchImpl: fetchOf(fetchMock), now: NOW });

    expect(all.map((s) => s.region)).toEqual(["AUS", "DARWIN"]);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([buildCpiDataUrl("AUS"), buildCpiDataUrl("DARWIN")]);
    expect(urls.some((u) => u.includes("+"))).toBe(false);
  });

  it("fails as a whole when one region cannot be fetched", async () => {
    const fetchMock = jest.fn(async (url: string) =>
      url.includes(".7.Q") ? reply(404, "NoRecordsFound") : reply(200, AUS_TEXT),
    );
    await expect(
      fetchAllCpiSeries({ fetchImpl: fetchOf(fetchMock), sleepImpl: noSleep, now: NOW }),
    ).rejects.toThrow(/DARWIN: ABS responded 404/);
  });

  it("fails when the regions disagree on the reference base", async () => {
    const rebased = darwinJson();
    rebased.data.structures[0].attributes.dataSet[0].values[0].name = "Dec 2030 = 100.0";
    const fetchMock = byRegion(JSON.stringify(rebased));
    await expect(
      fetchAllCpiSeries({ fetchImpl: fetchOf(fetchMock), now: NOW }),
    ).rejects.toThrow(/regions disagree on the reference base: AUS "Sep 2025 = 100\.0", DARWIN "Dec 2030 = 100\.0"/);
  });
});
