import {documentDateStatus,parseDocumentInput} from './documentRegister';
const input={title:'Fire services report',kind:'certificate',category:'Fire / life safety',buildingId:-7,tenantId:null,issuedOn:'2026-01-01',expiresOn:'2027-01-01',reviewDue:null,ownerName:'Facilities',notes:''};
it('supports explicit certificate dates and manual buildings',()=>expect(parseDocumentInput(input)).toMatchObject({buildingId:-7,expiresOn:'2027-01-01'}));
it.each([{issuedOn:'2026-02-30'},{expiresOn:'2025-12-01'},{kind:'lease'},{category:'unknown'},{buildingId:1.2},{tenantId:1,buildingId:null}])('refuses invalid metadata %j',patch=>expect(()=>parseDocumentInput({...input,...patch})).toThrow());
it('distinguishes expired evidence, review due and missing dates',()=>{expect(documentDateStatus('2026-10-18',null,'2026-10-19')).toBe('expired');expect(documentDateStatus(null,'2026-10-01','2026-10-19')).toBe('due');expect(documentDateStatus(null,null,'2026-10-19')).toBe('undated');expect(documentDateStatus('2027-01-01',null,'2026-10-19')).toBe('current');});
it('links original certificates of currency to a contractor and insurance type',()=>{
 expect(parseDocumentInput({...input,category:'Insurance',contractorId:12,insuranceType:'Public liability'})).toMatchObject({contractorId:12,insuranceType:'Public liability'});
 expect(()=>parseDocumentInput({...input,contractorId:12})).toThrow();
 expect(()=>parseDocumentInput({...input,insuranceType:'Public liability'})).toThrow();
});
