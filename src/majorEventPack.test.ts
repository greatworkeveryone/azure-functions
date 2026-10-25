import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { majorEventPack } from "./majorEventPack";
it("keeps the original evidence bytes embedded in the handover PDF", async () => {
  const original = Buffer.from('%PDF-1.4\nOriginal fictional evidence\n%%EOF');
  const bytes = await majorEventPack({ id: 7, title: 'DEMO shutdown', status: 'active', domain: 'operational', brief: 'Test handover', ownerName: 'Team lead', startsAt: '2026-10-19T08:00:00Z', endsAt: null, plan: { buildingIds: [-7], jobIds: [], actions: [] } }, [], [{ BuildingID: -7, BuildingName: 'Melville St Flats' }], [{ name: 'original.pdf', bytes: original, contentType: 'application/pdf' }]);
  expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
  const pdf = await PDFDocument.load(bytes);
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict);
  const embedded = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  const spec = embedded.lookup(1, PDFDict);
  const stream = pdf.context.lookup(spec.lookup(PDFName.of('EF'), PDFDict).get(PDFName.of('F'))) as PDFRawStream;
  expect(Buffer.from(decodePDFRawStream(stream).decode())).toEqual(original);
});
