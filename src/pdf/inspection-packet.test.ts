import { PDFDocument as PDFLibDocument } from "pdf-lib";
import { buildInspectionPacket, InspectionPacketInput } from "./inspection-packet";

// 1x1 transparent PNG — a valid image PDFKit can embed.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function baseInput(): InspectionPacketInput {
  return {
    id: 42,
    title: "Quarterly walkthrough",
    buildingName: "Riverside Tower",
    status: "complete",
    createdByName: "Jane Doe",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    completedByName: "Jane Doe",
    completedAt: new Date("2026-07-05T00:00:00.000Z"),
    totals: { levels: 1, rooms: 1, issues: 2, jobs: 1 },
    levels: [
      {
        name: "Level 2",
        rooms: [
          {
            name: "Kitchen",
            points: [
              {
                description: "Water damage under sink",
                addedByName: "Jane Doe",
                addedAt: new Date("2026-07-01T00:00:00.000Z"),
                raisedJobIds: [33],
                photos: [
                  { fileName: "a.png", bytes: PNG_1x1 },
                  { fileName: "b.png", bytes: PNG_1x1 },
                  { fileName: "c.png", bytes: PNG_1x1 },
                ],
              },
              {
                description: "Cracked tile",
                addedByName: "Jane Doe",
                addedAt: new Date("2026-07-01T00:00:00.000Z"),
                raisedJobIds: [],
                photos: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("buildInspectionPacket", () => {
  it("produces a non-empty PDF", async () => {
    const pdf = await buildInspectionPacket(baseInput());
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("handles empty levels and rooms without throwing", async () => {
    const input = baseInput();
    input.levels.push({ name: "Level 3", rooms: [] });
    input.levels[0].rooms.push({ name: "Empty room", points: [] });
    const pdf = await buildInspectionPacket(input);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("skips an unreadable photo instead of throwing", async () => {
    const input = baseInput();
    input.levels[0].rooms[0].points[0].photos = [
      { fileName: "broken.png", bytes: Buffer.from("not an image") },
      { fileName: "ok.png", bytes: PNG_1x1 },
    ];
    const pdf = await buildInspectionPacket(input);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("paginates across multiple pages when content overflows one A4 page", async () => {
    const input = baseInput();
    const points = Array.from({ length: 15 }, (_, n) => ({
      description: `Issue ${n + 1}`,
      addedByName: "Jane Doe",
      addedAt: new Date("2026-07-01T00:00:00.000Z"),
      raisedJobIds: [],
      photos: [
        { fileName: "a.png", bytes: PNG_1x1 },
        { fileName: "b.png", bytes: PNG_1x1 },
        { fileName: "c.png", bytes: PNG_1x1 },
        { fileName: "d.png", bytes: PNG_1x1 },
      ],
    }));
    input.levels = [{ name: "Level 1", rooms: [{ name: "Room 1", points }] }];

    const pdf = await buildInspectionPacket(input);
    const parsed = await PDFLibDocument.load(pdf);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });
});
