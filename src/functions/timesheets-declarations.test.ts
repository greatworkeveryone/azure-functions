import {app,HttpRequest,type InvocationContext} from '@azure/functions';
import {executeQuery} from '../db';
jest.mock('@azure/functions',()=>({...jest.requireActual('@azure/functions'),app:{http:jest.fn()}}));
jest.mock('../db',()=>({createRequestConnection:jest.fn(async()=>({})),closeConnection:jest.fn(),executeQuery:jest.fn()}));
jest.mock('../auth',()=>({...jest.requireActual('../auth'),extractToken:()=> 'token',requireRole:async()=>null,rolesForRequest:async()=>['facilities'],verifiedIdentityFromRequest:async()=>({oid:'actor',name:'Actor'})}));
jest.mock('../rateLimit',()=>({checkRateLimit:()=>({allowed:true})}));
require('./timesheets');
const registered=jest.mocked(app.http);
const handlers=new Map(registered.mock.calls.map(call=>[call[0],call[1].handler!]));
const handler=(name:string)=>handlers.get(name)!;
const context={error:jest.fn(),log:jest.fn()} as unknown as InvocationContext;
const req=(body:unknown)=>new HttpRequest({method:'POST',url:'http://localhost/api/timesheet',headers:{'Content-Type':'application/json'},body:{string:JSON.stringify(body)}});
const query=jest.mocked(executeQuery);
beforeEach(()=>jest.clearAllMocks());
it('stores typed leave intact in the existing JSON record',async()=>{
 const data={monday:[{type:'annual_leave',declaredMinutes:450,startTime:'',endTime:'',breakMinutes:0,comment:'Leave'}]};
 query.mockResolvedValueOnce([]).mockResolvedValueOnce([{TimesheetID:1}]).mockResolvedValueOnce([{TimesheetID:1,Data:JSON.stringify(data)}]);
 const result=await handler('upsertTimesheet')(req({weekStart:'2026-10-14',data}),context);expect(result!.status).toBe(200);
 const insert=query.mock.calls.find(([,sql])=>sql.includes('INSERT INTO dbo.Timesheets'))!;expect(insert[2]?.find(param=>param.name==='Data')?.value).toBe(JSON.stringify(data));
});
it('refuses an invalid type before opening the database',async()=>{
 const result=await handler('upsertTimesheet')(req({weekStart:'2026-10-14',data:{monday:[{type:'anything',startTime:'',endTime:'',breakMinutes:0,comment:''}]}}),context);expect(result!.status).toBe(400);expect(query).not.toHaveBeenCalled();
});
it('refuses incomplete draft submission before changing approval state',async()=>{
 query.mockResolvedValueOnce([{UserID:'actor',Approved:false,ReadyForApproval:false,Data:JSON.stringify({monday:[{startTime:'08:',endTime:'',breakMinutes:30,comment:''}]})}]);
 const result=await handler('submitTimesheetForApproval')(req({timesheetId:1,submit:true}),context);expect(result!.status).toBe(400);expect(query).toHaveBeenCalledTimes(1);
});
