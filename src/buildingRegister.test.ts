import { emptyBuildingProfile, parseBuildingProfile } from "./buildingRegister";
const lot = {
  id: "00000000-0000-4000-8000-000000000001",
  lotNumber: " 41 ",
  planNumber: " LTO 123 ",
  titleReference: "Volume 1 Folio 2",
  areaSqm: 300,
};
const input = { buildingId: -7, revision: 0, profile: { ...emptyBuildingProfile(), lots: [lot] } };
it("preserves references and numeric areas without inventing missing property facts", () => {
  const result = parseBuildingProfile(input);
  expect(result.profile.lots[0].lotNumber).toBe("41");
  expect(result.profile.landAreaSqm).toBeNull();
  expect(result.profile.contacts).toEqual([]);
});
it.each([
  { buildingId: 0 },
  { revision: -1 },
  { profile: { landAreaSqm: -1 } },
  { profile: { yearBuilt: 2026.5 } },
  { profile: { lots: [{ ...lot, id: "x" }] } },
  { profile: { lots: [lot, lot] } },
  { profile: { contacts: [{ id: lot.id, name: "Contact", role: "" }] } },
  { profile: { contacts: [{ id: lot.id, name: "Contact", role: "Agent", email: "invalid" }] } },
])("rejects invalid register input %j", (patch) =>
  expect(() => parseBuildingProfile({ ...input, ...patch })).toThrow(),
);
it("keeps separate lots sharing a number when their plan references differ", () =>
  expect(
    parseBuildingProfile({
      ...input,
      profile: { lots: [lot, { ...lot, id: "00000000-0000-4000-8000-000000000002", planNumber: "LTO 456" }] },
    }).profile.lots,
  ).toHaveLength(2));
