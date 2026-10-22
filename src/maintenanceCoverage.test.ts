import { parseCoverageInput } from "./maintenanceCoverage";
const input = {
  buildingId: -7,
  revision: 0,
  trades: [{ trade: "Electrical", required: true, contractorIds: [10, 10] }],
};
it("accepts explicit coverage and deduplicates contractors without inventing a required trade", () => {
  expect(parseCoverageInput(input).trades[0]).toEqual({
    trade: "Electrical",
    required: true,
    contractorIds: [10],
  });
  expect(parseCoverageInput({ ...input, trades: [] }).trades).toEqual([]);
});
it.each([
  { buildingId: 0 },
  { buildingId: 1.2 },
  { revision: -1 },
  { trades: [{ trade: "", required: true, contractorIds: [] }] },
  { trades: [{ trade: "Electrical", required: "yes", contractorIds: [] }] },
  { trades: [{ trade: "Electrical", required: true, contractorIds: [1.2] }] },
  { trades: [input.trades[0], { ...input.trades[0], trade: " ELECTRICAL " }] },
])("rejects invalid or ambiguous coverage %j", (patch) =>
  expect(() => parseCoverageInput({ ...input, ...patch })).toThrow(),
);
