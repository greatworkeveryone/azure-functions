import { parseContractorCoverage } from './contractorCoverage';
const input={contractorId:7,revision:0,regions:['Darwin','Katherine','Darwin'],trades:[' Electrical ']};
it('records multiple confirmed regions without implying building assignments',()=>expect(parseContractorCoverage(input)).toEqual({...input,regions:['Darwin','Katherine'],trades:['Electrical']}));
it('leaves unknown availability unset',()=>expect(parseContractorCoverage({...input,regions:[],trades:[]}).regions).toEqual([]));
it.each([{contractorId:0},{contractorId:1.2},{revision:-1},{regions:['NT']},{regions:'Darwin'},{trades:['Electrical',' ELECTRICAL ']},{trades:[null]},{trades:['x'.repeat(101)]}])('rejects invalid or ambiguous input %j',patch=>expect(()=>parseContractorCoverage({...input,...patch})).toThrow());
