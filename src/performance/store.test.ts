import {executeQuery} from '../db';
import {loadPerformance,PerformanceScopeTooLarge} from './store';
import {parsePeriod} from '../usage/period';
jest.mock('../db',()=>({executeQuery:jest.fn()}));
const query=jest.mocked(executeQuery),connection={} as Parameters<typeof loadPerformance>[0];
const parsed=parsePeriod(new URLSearchParams({days:'30'}));if('error'in parsed)throw Error(parsed.error);
beforeEach(()=>query.mockReset());
it('excludes test/archive/future records in SQL, binds scope, and fetches narrow typed history without descriptions',async()=>{
 query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
 const report=await loadPerformance(connection,parsed.period,33532);
 const [sql,params]=query.mock.calls[0].slice(1);expect(sql).toMatch(/ISNULL\(j.IsTest,0\)=0/);expect(sql).toMatch(/ISNULL\(j.IsArchived,0\)=0/);expect(sql).toContain('j.CreatedAt<=@Now');expect(params).toEqual(expect.arrayContaining([expect.objectContaining({name:'Building',value:33532})]));
 expect(query.mock.calls[1][1]).toContain('e.NewStatus');expect(query.mock.calls.map(call=>call[1]).join(' ')).not.toMatch(/Description|Comment|SELECT \*/);expect(report.buildingId).toBe(33532);expect(query.mock.calls[2][1]).toContain("ja.UnlinkedAt IS NULL");
});
it('refuses over-cap reads instead of silently analysing a partial portfolio',async()=>{
 query.mockResolvedValueOnce(Array.from({length:20001},()=>({})));
 await expect(loadPerformance(connection,parsed.period,null)).rejects.toBeInstanceOf(PerformanceScopeTooLarge);expect(query).toHaveBeenCalledTimes(1);
});
