import {validateBlocks} from './procedureLibrary';
import {procedureSearchText} from './procedureSearchText';
describe('controlled procedure modules',()=>{
 it('accepts reusable templates without storing completed run answers',()=>{
  expect(validateBlocks([{id:'c',kind:'checklist',items:['Check tyres']},{id:'s',kind:'steps',items:['Read procedure']},{id:'d',kind:'decision',question:'Safe?',yes:'Proceed',no:'Stop'},{id:'f',kind:'diagram',items:['Assess','Notify']}])).toBeNull();
 });
 it.each<unknown[]>([
  [{id:'x',kind:'checklist',items:[{answer:true}]}],
  [{id:'x',kind:'decision',question:'Safe?',yes:[],no:'Stop'}],
  [{id:'x',kind:'image',url:'javascript:alert(1)',alt:'Image'}],
  [{id:'x',kind:'paragraph',text:'One'},{id:'x',kind:'paragraph',text:'Two'}],
 ])('rejects malformed modules before they reach the renderer',(...blocks)=>expect(validateBlocks(blocks)).not.toBeNull());
 it('indexes plain human text but never image URLs or unknown module fields',()=>{
  expect(procedureSearchText([{kind:'image',url:'https://secret.test/file',alt:'Tyre check'},{kind:'decision',question:'Safe?',yes:'Proceed',no:'Stop',actor:'Private'},{kind:'html',text:'not supported'}])).toBe('Tyre check Safe? Proceed Stop');
 });
});
