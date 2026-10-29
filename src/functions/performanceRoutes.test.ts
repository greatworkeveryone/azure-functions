import {HttpRequest,type InvocationContext} from '@azure/functions';
import {AppRole} from '../auth';
import {createRequestConnection,executeQuery,beginTransaction,commitTransaction,rollbackTransaction} from '../db';
import {buildPerformance} from '../performance/model';
import {parsePeriod} from '../usage/period';
import {loadPerformance} from '../performance/store';
import {getFloorplanPerformance} from './getFloorplanPerformance';
import {getFloorplanAdoption} from './getFloorplanAdoption';
import {getPerformanceImprovements} from './getPerformanceImprovements';
import {getWorkflowFriction} from './getWorkflowFriction';
import {savePerformanceImprovement} from './savePerformanceImprovement';
import {postWorkflowSignals} from './postWorkflowSignals';
let roles:string[]=[AppRole.DIRECTOR],token:string|null='token';
jest.mock('@azure/functions',()=>({...jest.requireActual('@azure/functions'),app:{http:jest.fn()}}));
jest.mock('../auth',()=>({...jest.requireActual('../auth'),extractToken:()=>token,requireRole:async()=>null,rolesForRequest:async()=>roles,verifiedIdentityFromRequest:async()=>({name:'Verified director',oid:'verified-oid'}),oidFromToken:()=> 'verified-oid'}));
jest.mock('../db',()=>({createRequestConnection:jest.fn(async()=>({})),closeConnection:jest.fn(),executeQuery:jest.fn(async()=>[]),beginTransaction:jest.fn(async()=>undefined),commitTransaction:jest.fn(async()=>undefined),rollbackTransaction:jest.fn(async()=>undefined)}));
jest.mock('../performance/store',()=>({...jest.requireActual('../performance/store'),loadPerformance:jest.fn()}));
jest.mock('../usage/flag',()=>({usageFlagEnabledFor:jest.fn(async()=>true)}));
jest.mock('../usage/ingest',()=>({userIdForOid:jest.fn(async()=>8)}));
jest.mock('../usage/rateLimit',()=>({allowUsageBatch:jest.fn(()=>true)}));
import {usageFlagEnabledFor} from '../usage/flag';
import {allowUsageBatch} from '../usage/rateLimit';
const ctx={error:jest.fn()} as unknown as InvocationContext;
const get=(query='')=>new HttpRequest({method:'GET',url:`http://localhost/api/test${query}`});
const post=(body:unknown)=>new HttpRequest({method:'POST',url:'http://localhost/api/test',body:{string:JSON.stringify(body)}});
const query=jest.mocked(executeQuery),load=jest.mocked(loadPerformance);
const definition={title:'Reduce waiting',ownerId:8,metric:'stalled',target:0,reviewOn:'2099-12-01',buildingId:null,days:30,note:'Clear the backlog'};
const frozen={...definition,baseline:4,baselineAt:'2026-10-01T00:00:00Z',status:'open',ownerName:'Manager',definitionVersion:1};
beforeEach(()=>{jest.clearAllMocks();query.mockReset();query.mockResolvedValue([]);roles=[AppRole.DIRECTOR];token='token';delete process.env.USAGE_TRACKING_ENABLED;jest.mocked(usageFlagEnabledFor).mockResolvedValue(true);jest.mocked(allowUsageBatch).mockReturnValue(true);const parsed=parsePeriod(new URLSearchParams({days:'30'}));if('error'in parsed)throw Error(parsed.error);load.mockResolvedValue(buildPerformance([],[],parsed.period));});
const reads=[getFloorplanPerformance,getFloorplanAdoption,getPerformanceImprovements,getWorkflowFriction];
it.each(reads)('read handler blocks missing identity/CFO/staff before touching the database',async handler=>{
 token=null;expect((await handler(get(),ctx)).status).toBe(401);token='token';for(const role of [AppRole.CFO,AppRole.FACILITIES_APPROVAL,AppRole.USER]){roles=[role];expect((await handler(get(),ctx)).status).toBe(403);}expect(createRequestConnection).not.toHaveBeenCalled();
});
it.each(reads)('read handler permits technical admin without granting improvement-write authority',async handler=>{roles=[AppRole.ADMIN];expect((await handler(get(),ctx)).status).toBe(200);});
it.each(['?buildingId=no','?buildingId=0','?from=2026-10-01','?from=2099-01-01&to=2099-01-02','?list=no','?page=-1','?stage=made-up','?dimension=team','?dimension=made-up&key=x'])('refuses malformed evidence filters before any query: %s',async params=>{expect((await getFloorplanPerformance(get(params),ctx)).status).toBe(400);expect(createRequestConnection).not.toHaveBeenCalled();});
it('returns a paged matching evidence set, never the internal full record collection',async()=>{
 const rows=Array.from({length:61},(_,id)=>({id,status:'Work',stage:'In progress',ageDays:id,stalled:true,overdue:false}));const parsed=parsePeriod(new URLSearchParams({days:"30"}));if("error"in parsed)throw Error(parsed.error);load.mockResolvedValue({...buildPerformance([],[],parsed.period),records:rows} as never);
 const response=await getFloorplanPerformance(get('?list=stalled&page=1'),ctx);expect(response.status).toBe(200);expect(response.jsonBody).toMatchObject({evidenceTotal:61,evidencePage:1,evidence:expect.any(Array)});expect((response.jsonBody as {evidence:unknown[]}).evidence).toHaveLength(11);expect(response.jsonBody).not.toHaveProperty('records');
});
it('admin and CFO cannot mutate targets',async()=>{for(const role of [AppRole.ADMIN,AppRole.CFO]){roles=[role];expect((await savePerformanceImprovement(post(definition),ctx)).status).toBe(403);}expect(createRequestConnection).not.toHaveBeenCalled();});
it('creates a server baseline and history in the same transaction, ignoring a client-supplied baseline',async()=>{
 query.mockResolvedValueOnce([{DisplayName:'Manager'}]).mockResolvedValueOnce([{ImprovementId:3}]).mockResolvedValueOnce([]);
 const response=await savePerformanceImprovement(post({...definition,baseline:999}),ctx);expect(response.status).toBe(200);expect(beginTransaction).toHaveBeenCalled();expect(commitTransaction).toHaveBeenCalled();const insert=query.mock.calls.find(call=>call[1].startsWith('INSERT dbo.PerformanceImprovements'))!;const data=JSON.parse(String(insert[2]?.find(p=>p.name==='Data')?.value));expect(data.baseline).toBe(0);expect(data).toMatchObject({definitionVersion:1,ownerName:'Manager'});expect(query.mock.calls.at(-1)?.[1]).toContain('PerformanceImprovementHistory');expect(query.mock.calls.at(-1)?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({name:'Oid',value:'verified-oid'})]));
});
it('rejects stale revisions and rolls back without writing',async()=>{query.mockResolvedValueOnce([{DataJson:JSON.stringify(frozen),Revision:2,Status:'open'}]);expect((await savePerformanceImprovement(post({id:3,revision:1,status:'closed',note:'Review'}),ctx)).status).toBe(409);expect(query).toHaveBeenCalledTimes(1);expect(rollbackTransaction).toHaveBeenCalled();expect(commitTransaction).not.toHaveBeenCalled();});
it('cannot edit an archived improvement',async()=>{query.mockResolvedValueOnce([{DataJson:JSON.stringify(frozen),Revision:1,Status:'archived'}]);expect((await savePerformanceImprovement(post({id:3,revision:1,status:'open',note:'Review'}),ctx)).status).toBe(409);expect(query).toHaveBeenCalledTimes(1);});
it('preserves baseline and records an inconclusive closure when current resolution evidence is missing',async()=>{
 query.mockResolvedValueOnce([{DataJson:JSON.stringify({...frozen,metric:'medianDays'}),Revision:1,Status:'open'}]).mockResolvedValue([]);
 expect((await savePerformanceImprovement(post({id:3,revision:1,status:'closed',note:'No reliable sample',baseline:999}),ctx)).status).toBe(200);
 const update=query.mock.calls.find(call=>call[1].startsWith('UPDATE'))!;expect(JSON.parse(String(update[2]?.find(p=>p.name==='Data')?.value))).toMatchObject({baseline:4,outcome:'inconclusive',reviewedValue:null});
});
it('rolls back the target update if its immutable history insert fails',async()=>{query.mockResolvedValueOnce([{DisplayName:'Manager'}]).mockResolvedValueOnce([{ImprovementId:3}]).mockRejectedValueOnce(Error('history unavailable'));expect((await savePerformanceImprovement(post(definition),ctx)).status).toBe(500);expect(rollbackTransaction).toHaveBeenCalled();expect(commitTransaction).not.toHaveBeenCalled();});
it('requires an eligible owner and a reliable baseline',async()=>{expect((await savePerformanceImprovement(post(definition),ctx)).status).toBe(400);query.mockResolvedValueOnce([{DisplayName:'Manager'}]);expect((await savePerformanceImprovement(post({...definition,metric:'medianDays'}),ctx)).status).toBe(400);expect(commitTransaction).not.toHaveBeenCalled();});
it('does not ingest anything when tracking is off, when rollout is hidden, or after the rate cap',async()=>{
 expect((await postWorkflowSignals(post({private:'not even read'}),ctx)).status).toBe(204);expect(createRequestConnection).not.toHaveBeenCalled();process.env.USAGE_TRACKING_ENABLED='true';const batch=[{id:'d64fa838-4b02-401e-92b0-d4b9fc4fa425',operation:'job-save',outcome:'ok',durationMs:23}];jest.mocked(usageFlagEnabledFor).mockResolvedValueOnce(false);expect((await postWorkflowSignals(post(batch),ctx)).status).toBe(204);expect(query).not.toHaveBeenCalled();jest.mocked(allowUsageBatch).mockReturnValueOnce(false);expect((await postWorkflowSignals(post(batch),ctx)).status).toBe(429);expect(query).not.toHaveBeenCalled();
});
it('does not accept arbitrary text or overlarge telemetry batches',async()=>{process.env.USAGE_TRACKING_ENABLED='true';expect((await postWorkflowSignals(post([{text:'private'}]),ctx)).status).toBe(400);expect((await postWorkflowSignals(post({text:'x'.repeat(13000)}),ctx)).status).toBe(413);expect(createRequestConnection).not.toHaveBeenCalled();});
