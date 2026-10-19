const PDFDocument = require('pdfkit');

/** Small, clearly fictional evidence files for the isolated client-demo pack. */
function createDemoEvidence({ kind, number, contractor, building, title, amount }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${number} - fictional demo evidence`, Author: 'Floorplan local demo' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.rect(0, 0, 596, 108).fill('#17212b');
    doc.fillColor('#61d6b6').font('Helvetica-Bold').fontSize(10).text('FLOORPLAN / CLIENT DEMONSTRATION', 48, 30);
    doc.fillColor('#ffffff').fontSize(24).text(kind === 'quote' ? 'Contractor proposal' : 'Sample invoice', 48, 53);
    doc.fillColor('#67717c').font('Helvetica').fontSize(10).text('FICTIONAL DOCUMENT - NOT VALID FOR PROCUREMENT OR PAYMENT', 48, 128, { width: 490 });
    doc.fillColor('#17212b').font('Helvetica-Bold').fontSize(17).text(contractor, 48, 164, { width: 490 });
    doc.font('Helvetica').fontSize(11).text(`Reference: ${number}`, 48, doc.y + 12);
    doc.text(`Property: ${building}`, { width: 490 });
    doc.moveDown().font('Helvetica-Bold').text(title.replace('[DEMO] ', ''), { width: 490 });
    doc.moveDown().font('Helvetica').text('Scope: inspect the reported issue, confirm safe access, complete the agreed repair, test operation and leave the work area clean. Supply before/after evidence for the facilities manager.', { width: 490, lineGap: 4 });
    const top = Math.max(340, doc.y + 32);
    doc.moveTo(48, top).lineTo(547, top).strokeColor('#d5dce1').stroke();
    doc.font('Helvetica-Bold').text('Demonstration total (AUD)', 48, top + 18);
    doc.fontSize(24).text(new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount), 48, top + 43);
    doc.font('Helvetica').fontSize(10).fillColor('#67717c').text('This total matches the linked Floorplan demo record. It makes no GST or tax-invoice representation. No goods, services, approval or payment are evidenced by this sample.', 48, top + 86, { width: 490, lineGap: 3 });
    doc.rect(48, 660, 499, 90).fill('#eef3f5');
    doc.fillColor('#17212b').font('Helvetica-Bold').fontSize(11).text('Demo review checklist', 64, 676);
    doc.font('Helvetica').fontSize(10).text('Check the scope and amount against the job. Review the approval authority. Confirm who owns the next step and when it is due.', 64, 698, { width: 465, lineGap: 3 });
    doc.fillColor('#67717c').fontSize(9).text('Local fictional fixture | External dispatch disabled | 1 / 1', 48, 780);
    doc.end();
  });
}
module.exports = { createDemoEvidence };
