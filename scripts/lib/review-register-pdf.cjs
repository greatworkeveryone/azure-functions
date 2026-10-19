const PDFDocument = require('pdfkit');
function createRegisterEvidence(record) {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:48,info:{Title:record.Title,Author:'Floorplan local demo'}}), chunks=[];
    doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#17735f').text('FLOORPLAN / FICTIONAL DEMONSTRATION');
    doc.moveDown().fillColor('#17212b').fontSize(22).text(record.Title);
    doc.moveDown().font('Helvetica').fontSize(11).text('NOT A VALID CERTIFICATE, LEGAL AGREEMENT OR COMPLIANCE RECORD.');
    doc.moveDown().text(`Building: ${record.BuildingName}`).text(`Responsible person: ${record.OwnerName}`);
    doc.moveDown().text(`Issued: ${record.IssuedOn ?? 'Not recorded'}`).text(`Expiry: ${record.ExpiresOn ?? 'Not recorded'}`).text(`Review due: ${record.ReviewDue ?? 'Not recorded'}`);
    doc.moveDown().text(record.Notes,{lineGap:5});
    doc.moveDown().text('Review the linked record, test the building and date filters, and download the original evidence. No service, certification, endorsement or legal commitment is represented by this sample.',{lineGap:5});
    doc.end();
  });
}
module.exports={createRegisterEvidence};
