import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TYPES, type Connection } from 'tedious';
import { authorize, badRequest, notFound } from '../assetRegisterSupport';
import { VIEW_ASSETS_ROLES } from '../assetRegister';
import { emptyBuildingProfile } from '../buildingRegister';
import { errorResponse } from '../auth';
import { closeConnection, createRequestConnection, executeQuery } from '../db';
export async function getBuildingRegister(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await authorize(request,VIEW_ASSETS_ROLES);if(!auth.ok)return auth.response;
 const raw=request.query.get('buildingId'),buildingId=raw===null?NaN:Number(raw);
 if(!Number.isInteger(buildingId)||!buildingId||Math.abs(buildingId)>2147483647)return badRequest('Choose a building');
 let connection:Connection|undefined;
 try{connection=await createRequestConnection(auth.token);const params=[{name:'Building',type:TYPES.Int,value:buildingId}];
  const rows=await executeQuery(connection,'SELECT b.BuildingID,r.ProfileJson,r.Revision,r.UpdatedAt,r.UpdatedBy FROM dbo.Buildings b LEFT JOIN dbo.BuildingRegister r ON r.BuildingId=b.BuildingID WHERE b.BuildingID=@Building',params);
  if(!rows.length)return notFound('Building unavailable');const current=rows[0];
  const history=await executeQuery(connection,'SELECT TOP(20) Revision,ActorName,CreatedAt FROM dbo.BuildingRegisterAudit WHERE BuildingId=@Building ORDER BY AuditId DESC',params);
  return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{buildingId,profile:current.ProfileJson?JSON.parse(current.ProfileJson):emptyBuildingProfile(),revision:current.Revision??0,updatedAt:current.UpdatedAt??null,updatedBy:current.UpdatedBy??null,history:history.map(row=>({revision:row.Revision,actor:row.ActorName,createdAt:row.CreatedAt}))}};
 }catch(error){context.error('Building register read failed',error);return errorResponse('Could not load building details',error);}finally{if(connection)closeConnection(connection);}
}
app.http('getBuildingRegister',{authLevel:'anonymous',handler:getBuildingRegister,methods:['GET']});
