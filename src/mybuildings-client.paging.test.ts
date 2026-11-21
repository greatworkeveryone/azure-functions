/// <reference types="jest" />
// SECS-08: an upstream that keeps returning full pages is read for at most MAX_PAGES pages.
import { fetchWorkRequests, MAX_PAGES } from "./mybuildings-client";

const fetchMock = jest.fn();
beforeEach(() => {
  jest.restoreAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

it("stops after MAX_PAGES pages of an endless upstream and says so", async () => {
  const page = Array.from({ length: 300 }, (_, i) => ({ WorkRequestID: i }));
  fetchMock.mockResolvedValue({ json: async () => ({ Data: { WorkRequests: page } }), ok: true, status: 200, text: async () => "" });

  const rows = await fetchWorkRequests("lastmodifieddate=x");

  expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
  expect(rows).toHaveLength(MAX_PAGES * 300);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("stopped after"));
});

it("reads a short last page normally", async () => {
  fetchMock
    .mockResolvedValueOnce({ json: async () => ({ Data: { WorkRequests: Array.from({ length: 300 }, () => ({})) } }), ok: true, status: 200, text: async () => "" })
    .mockResolvedValueOnce({ json: async () => ({ Data: { WorkRequests: [{}] } }), ok: true, status: 200, text: async () => "" });
  expect(await fetchWorkRequests()).toHaveLength(301);
  expect(console.warn).not.toHaveBeenCalled();
});
