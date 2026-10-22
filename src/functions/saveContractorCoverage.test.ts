import { HttpRequest, type InvocationContext } from '@azure/functions';
import { AppRole } from '../auth';
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from '../db';
import { saveContractorCoverage } from './saveContractorCoverage';
jest.mock('@azure/functions',()=>({...jest.requireActual('@azure/functions'),app:{http:jest.fn()}}));
let roles:string[]=[AppRole.FACILITIES_APPROVAL];
jest.mock('../auth',()=>({...jest.requireActual('../auth'),extractToken:()=> 'token',requireRole:async(_r:unknown,allowed:string[])=>jest.requireActual('../auth').rolesPassGate(roles,allowed)?null:{status:403},verifiedIdentityFromRequest:async()=>({name:'Verified manager',oid:'manager-oid'})}));
jest.mock('../db',()=>({createRequestConnection:jest.fn(async()=>({})),closeConnection:jest.fn(),executeQuery:jest.fn(),beginTransaction:jest.fn().mockResolvedValue(undefined),commitTransaction:jest.fn().mockResolvedValue(undefined),rollbackTransaction:jest.fn().mockResolvedValue(undefined)}));
const query=jest.mocked(executeQuery);
const context={error:jest.fn()} as unknown as InvocationContext;
const request=(patch:Record<string,unknown>={})=>new HttpRequest({method:'POST',url:'http://localhost/api/saveContractorCoverage',headers:{'Content-Type':'application/json'},body:{string:JSON.stringify({contractorId:10,revision:0,regions:['Darwin'],trades:['Electrical'],...patch})}});
beforeEach(()=>{
 jest.clearAllMocks();roles=[AppRole.FACILITIES_APPROVAL];
 query.mockImplementation(async(_c,sql)=>sql.includes('FROM dbo.Contractors')?[{ContractorID:10,Active:true,Suspended:false}]:[]);
});
it('rejects ordinary facilities staff before querying or writing',async()=>{
 roles=[AppRole.FACILITIES];expect((await saveContractorCoverage(request(),context)).status).toBe(403);expect(query).not.toHaveBeenCalled();
});
it('rejects invalid input before starting a transaction',async()=>{
 expect((await saveContractorCoverage(request({revision:-1}),context)).status).toBe(400);expect(beginTransaction).not.toHaveBeenCalled();
});
it('stores the coverage and verified audit identity in one transaction',async()=>{
 expect((await saveContractorCoverage(request({actor:'forged'}),context)).status).toBe(200);
 expect(commitTransaction).toHaveBeenCalledTimes(1);
 const [,sql,params]=query.mock.calls.find(([,sql])=>sql.startsWith('INSERT dbo.ContractorCoverageAudit'))!;
 expect(sql).toContain('BeforeJson,AfterJson');expect(params).toEqual(expect.arrayContaining([expect.objectContaining({name:'Actor',value:'Verified manager'}),expect.objectContaining({name:'Oid',value:'manager-oid'})]));
});
it('rejects a stale revision without changing coverage or audit',async()=>{
 query.mockImplementation(async(_c,sql)=>sql.includes('FROM dbo.Contractors')?[{ContractorID:10}]:[{Revision:2,CoverageJson:'{}'}]);
 expect((await saveContractorCoverage(request(),context)).status).toBe(409);
 expect(rollbackTransaction).toHaveBeenCalledTimes(1);expect(query.mock.calls.some(([,sql])=>/^(UPDATE|INSERT)/.test(sql))).toBe(false);
});
it('rolls back the coverage update when writing its audit fails',async()=>{
 query.mockImplementation(async(_c,sql)=>{if(sql.includes('FROM dbo.Contractors'))return [{ContractorID:10,Active:true,Suspended:false}];if(sql.startsWith('INSERT dbo.ContractorCoverageAudit'))throw new Error('audit failed');return [];});
 expect((await saveContractorCoverage(request(),context)).status).toBe(500);expect(rollbackTransaction).toHaveBeenCalledTimes(1);expect(commitTransaction).not.toHaveBeenCalled();
});
