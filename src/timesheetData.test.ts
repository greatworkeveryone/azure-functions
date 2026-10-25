import {validateTimesheetData} from './timesheetData';
const work={startTime:'08:00',endTime:'16:30',breakMinutes:30,comment:''};
it('keeps historical clock entries and typed overtime valid',()=>{expect(validateTimesheetData({monday:[work]},true)).toBeNull();expect(validateTimesheetData({monday:[{...work,type:'overtime'}]},true)).toBeNull();});
it('retains typed leave without fake clock times',()=>expect(validateTimesheetData({monday:[{type:'annual_leave',declaredMinutes:450,startTime:'',endTime:'',breakMinutes:0,comment:''}]},true)).toBeNull());
it('allows an incomplete draft but refuses its submission',()=>{const data={monday:[{...work,startTime:'08:'}]};expect(validateTimesheetData(data)).toBeNull();expect(validateTimesheetData(data,true)).not.toBeNull();});
it.each([{type:'unknown'},{breakMinutes:-1},{declaredMinutes:1441},{comment:'x'.repeat(2001)}])('refuses invalid declarations %j',patch=>expect(validateTimesheetData({monday:[{...work,...patch}]})).not.toBeNull());
it('does not accept clock hours hidden on leave or not-worked rows',()=>{expect(validateTimesheetData({monday:[{...work,type:'annual_leave',declaredMinutes:480}]})).not.toBeNull();expect(validateTimesheetData({monday:[{...work,type:'not_worked'}]})).not.toBeNull();});
