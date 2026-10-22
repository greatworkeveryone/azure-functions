export interface BuildingLot { id:string; lotNumber:string; planNumber:string; titleReference:string; areaSqm:number|null }
export interface RegisterContact { id:string; role:string; name:string; organisation:string; phone:string; email:string }
export interface BuildingProfile { ownershipEntity:string; legalDescription:string; landAreaSqm:number|null; grossFloorAreaSqm:number|null; yearBuilt:number|null; notes:string; lots:BuildingLot[]; contacts:RegisterContact[] }
export const emptyBuildingProfile=():BuildingProfile=>({ownershipEntity:'',legalDescription:'',landAreaSqm:null,grossFloorAreaSqm:null,yearBuilt:null,notes:'',lots:[],contacts:[]});
const text=(v:unknown,max:number,label:string)=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.trim().length>max)throw new Error(`${label} must be text up to ${max} characters`);return v.trim();};
const area=(v:unknown)=>{if(v===undefined||v===null||v==='')return null;if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1e9)throw new Error('Areas must be positive square metres');return v;};
const row=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid register row');return v as Record<string,unknown>;};
const id=(v:unknown)=>{if(typeof v!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v))throw new Error('Register row ID required');return v.toLowerCase();};
export function parseBuildingProfile(body:Record<string,unknown>):{buildingId:number;revision:number;profile:BuildingProfile}{
 const {buildingId,revision}=body;
 if(typeof buildingId!=='number'||!Number.isInteger(buildingId)||buildingId===0||Math.abs(buildingId)>2147483647)throw new Error('Choose a building');
 if(typeof revision!=='number'||!Number.isInteger(revision)||revision<0||revision>=2147483647)throw new Error('Revision required');
 const p=row(body.profile),base=emptyBuildingProfile();
 const year=p.yearBuilt===undefined||p.yearBuilt===null||p.yearBuilt===''?null:p.yearBuilt;
 if(year!==null&&(typeof year!=='number'||!Number.isInteger(year)||year<1700||year>2200))throw new Error('Year built must be a year between 1700 and 2200');
 const lots=p.lots??[],contacts=p.contacts??[];
 if(!Array.isArray(lots)||lots.length>200)throw new Error('Use up to 200 lots');
 if(!Array.isArray(contacts)||contacts.length>30)throw new Error('Use up to 30 contacts');
 base.lots=lots.map(v=>{const l=row(v);const clean={id:id(l.id),lotNumber:text(l.lotNumber,100,'Lot number'),planNumber:text(l.planNumber,100,'Plan number'),titleReference:text(l.titleReference,160,'Title reference'),areaSqm:area(l.areaSqm)};if(!clean.lotNumber&&!clean.planNumber&&!clean.titleReference)throw new Error('Each lot needs a lot, plan or title reference');return clean;});
 base.contacts=contacts.map(v=>{const c=row(v);const clean={id:id(c.id),role:text(c.role,100,'Contact role'),name:text(c.name,160,'Contact name'),organisation:text(c.organisation,200,'Organisation'),phone:text(c.phone,80,'Phone'),email:text(c.email,254,'Email')};if(!clean.name||!clean.role)throw new Error('Each contact needs a name and role');if(clean.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email))throw new Error('Enter a valid contact email');return clean;});
 for(const rows of [base.lots,base.contacts])if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('Register row IDs must be distinct');
 const keys=base.lots.map(l=>`${l.lotNumber}|${l.planNumber}|${l.titleReference}`.toLocaleLowerCase('en-AU'));if(new Set(keys).size!==keys.length)throw new Error('Each lot reference must appear once');
 return {buildingId,revision,profile:{...base,ownershipEntity:text(p.ownershipEntity,240,'Ownership entity'),legalDescription:text(p.legalDescription,2000,'Legal description'),notes:text(p.notes,6000,'Notes'),landAreaSqm:area(p.landAreaSqm),grossFloorAreaSqm:area(p.grossFloorAreaSqm),yearBuilt:year as number|null}};
}
