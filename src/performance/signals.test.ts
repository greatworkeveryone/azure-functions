import {parseSignals,storeSignals} from './signals';
import {purgeWorkflowSignals} from './purgeSignals';
import {executeQuery} from '../db';
jest.mock('../db',()=>({executeQuery:jest.fn()}));
const query=jest.mocked(executeQuery),connection={} as Parameters<typeof storeSignals>[0];
const signal={id:'D64FA838-4B02-401E-92B0-D4B9FC4FA425',operation:'job-save',outcome:'ok',durationMs:125};
beforeEach(()=>query.mockReset());
it('accepts only content-free allowlisted fields with bounded duration/batch and normalises UUID',()=>{
 expect(parseSignals([signal])?.[0].id).toBe(signal.id.toLowerCase());
 for(const patch of [{url:'/jobs/4'},{error:'private'},{ownerId:5},{durationMs:-1},{durationMs:120001},{durationMs:1.1},{durationMs:NaN},{operation:'arbitrary'},{outcome:'custom'},{id:'bad'}])expect(parseSignals([{...signal,...patch}])).toBeNull();
 expect(parseSignals([])).toBeNull();expect(parseSignals(Array(21).fill(signal))).toBeNull();expect(parseSignals({})).toBeNull();
});
it('deduplicates a batch and binds caller identity rather than trusting any browser user',async()=>{
 query.mockResolvedValue([]);await storeSignals(connection,73,parseSignals([signal,signal])!);
 const sql=query.mock.calls[0][1],params=query.mock.calls[0][2];expect(sql).toContain('UPDLOCK,HOLDLOCK');expect(params).toEqual(expect.arrayContaining([expect.objectContaining({name:'UserId',value:73})]));expect(JSON.parse(String(params?.find(p=>p.name==='Signals')?.value))).toHaveLength(1);
});
it('retention dry-run counts only; delete uses a positive cutoff and remains bounded',async()=>{
 query.mockResolvedValueOnce([{TableId:1}]).mockResolvedValueOnce([{N:6}]);await expect(purgeWorkflowSignals(connection,1,true,new Date('2026-10-29T00:00:00Z'))).resolves.toEqual({eligible:6,deleted:0});expect(query.mock.calls.some(call=>/DELETE/.test(call[1]))).toBe(false);
 query.mockReset();query.mockResolvedValueOnce([{TableId:1}]).mockResolvedValueOnce([{N:5001}]).mockResolvedValueOnce([{N:5000}]).mockResolvedValueOnce([{N:1}]);expect((await purgeWorkflowSignals(connection,180,false)).deleted).toBe(5001);expect(query.mock.calls[2][1]).toContain('DELETE TOP(5000) FROM dbo.WorkflowSignals WHERE RecordedAt<@Cutoff');
});
it('older databases without telemetry schema are left untouched',async()=>{query.mockResolvedValueOnce([{TableId:null}]);expect(await purgeWorkflowSignals(connection,180,false)).toEqual({eligible:0,deleted:0});expect(query).toHaveBeenCalledTimes(1);});
