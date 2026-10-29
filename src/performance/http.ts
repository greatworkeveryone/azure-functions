import {ACTION_ROLES} from "../action-roles";
import {AppRole,extractToken,requireRole,rolesForRequest,unauthorizedResponse} from "../auth";
import {parsePeriod} from "../usage/period";
import {darwinDay} from "../usage/days";
import type {HttpRequest,HttpResponseInit} from "@azure/functions";
export async function performanceAccess(request:HttpRequest,write=false):Promise<{token:string}|{response:HttpResponseInit}>{
 const token=extractToken(request);if(!token)return {response:unauthorizedResponse()};
 const denied=await requireRole(request,write?ACTION_ROLES.manageFloorplanImprovements.gate:ACTION_ROLES.viewFloorplanPerformance.gate);if(denied)return {response:denied};
 const roles=await rolesForRequest(request);
 if(!roles.includes(AppRole.DIRECTOR)&&!(roles.includes(AppRole.ADMIN)&&!write))return {response:{status:403,jsonBody:{error:write?"Only directors can change improvement targets.":"Whole-business performance is for directors and technical admins."}}};
 return {token};
}
export function performanceParams(query:URLSearchParams){
 const parsed=parsePeriod(query);if("error"in parsed)return parsed;
 if(parsed.period.to>darwinDay(new Date()))return {error:"The reporting period cannot end in the future."};
 const raw=query.get("buildingId");if(raw!==null&&(!/^-?\d+$/.test(raw)||Number(raw)===0||!Number.isSafeInteger(Number(raw))||Math.abs(Number(raw))>2147483647))return {error:"buildingId must be a non-zero whole number."};
 return {period:parsed.period,buildingId:raw===null?null:Number(raw)};
}
