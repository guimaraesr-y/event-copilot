import type { Hono } from 'hono'
import { z } from 'zod'
import type { OrganizationRepository } from '@ecc/database'
import { RiskConflictError, RiskNotFoundError, RiskValidationError, type EventRisk } from '@ecc/domain'
import type { RiskEngine } from '@ecc/event-engine'

const acknowledgeSchema=z.object({sender:z.string().min(2).max(160)})
const evaluateSchema=z.object({idempotencyKey:z.string().min(1).max(160).optional()}).optional()

export function registerRiskRoutes(app:Hono,organizations:OrganizationRepository,engine:RiskEngine):void{
  app.get('/api/v1/risks/workspace',async(c)=>{
    const ctx=await organizationContext(c,organizations);if('response'in ctx)return ctx.response
    const limit=numberQuery(c.req.query('limit'),20,1,50)
    const rows=await engine.workspaceSummary(ctx.organization.id,limit)
    return c.json({data:rows.map(row=>({eventId:row.eventId,eventName:row.eventName,eventStartAt:row.eventStartAt.toISOString(),maxScore:row.maxScore,
      maxSeverity:row.maxSeverity,activeCount:row.activeCount,criticalCount:row.criticalCount,highCount:row.highCount,risks:row.risks.map(serialize)}))})
  })
  app.get('/api/v1/risks',async(c)=>{
    const ctx=await organizationContext(c,organizations);if('response'in ctx)return ctx.response
    const eventId=optionalUuid(c.req.query('eventId'));if(eventId instanceof Response)return eventId
    const status=enumQuery(c.req.query('status'),['open','acknowledged','resolved']);if(status==='__invalid')return c.json({error:{code:'INVALID_RISK_STATUS',message:'Unsupported risk status'}},400)
    const severity=enumQuery(c.req.query('severity'),['low','medium','high','critical']);if(severity==='__invalid')return c.json({error:{code:'INVALID_RISK_SEVERITY',message:'Unsupported risk severity'}},400)
    const type=enumQuery(c.req.query('type'),['task_overdue','task_due_soon','vendor_unconfirmed','vendor_declined','vendor_schedule_review','dependency_unresolved','critical_inbox_item','recent_sensitive_change','change_dependency_pending']);if(type==='__invalid')return c.json({error:{code:'INVALID_RISK_TYPE',message:'Unsupported risk type'}},400)
    const minScoreRaw=c.req.query('minScore');const minScore=minScoreRaw===undefined?undefined:Number.parseInt(minScoreRaw,10)
    if(minScore!==undefined&&(!Number.isInteger(minScore)||minScore<0||minScore>100))return c.json({error:{code:'INVALID_MIN_SCORE',message:'minScore must be an integer from 0 to 100'}},400)
    const rows=await engine.list({organizationId:ctx.organization.id,...(eventId?{eventId}:{}),...(status?{status:status as any}:{}),...(severity?{severity:severity as any}:{}),...(type?{type:type as any}:{}),...(minScore!==undefined?{minScore}:{}),limit:numberQuery(c.req.query('limit'),50,1,200)})
    return c.json({data:rows.map(serialize)})
  })
  app.get('/api/v1/risks/:id',async(c)=>{
    const ctx=await organizationContext(c,organizations);if('response'in ctx)return ctx.response
    const id=c.req.param('id');if(!z.uuid().safeParse(id).success)return c.json({error:{code:'INVALID_RISK_ID',message:'id must be a UUID'}},400)
    try{return c.json({data:serialize(await engine.get(ctx.organization.id,id))})}catch(error){return mapError(c,error)}
  })
  app.post('/api/v1/events/:eventId/risks/evaluate',async(c)=>{
    const ctx=await organizationContext(c,organizations);if('response'in ctx)return ctx.response
    const eventId=c.req.param('eventId');if(!z.uuid().safeParse(eventId).success)return c.json({error:{code:'INVALID_EVENT_ID',message:'eventId must be a UUID'}},400)
    const raw=await c.req.json().catch(()=>undefined);const parsed=evaluateSchema.safeParse(raw)
    if(!parsed.success)return c.json({error:{code:'VALIDATION_ERROR',message:'Invalid risk evaluation payload',issues:parsed.error.issues}},400)
    try{const result=await engine.evaluateEvent({organizationId:ctx.organization.id,eventId,triggerType:'manual',triggerKey:`manual:${parsed.data?.idempotencyKey??crypto.randomUUID()}`});return c.json({data:{...result,risks:result.risks.map(serialize)}})}catch(error){return mapError(c,error)}
  })
  app.post('/api/v1/risks/:id/acknowledge',async(c)=>{
    const ctx=await organizationContext(c,organizations);if('response'in ctx)return ctx.response
    const id=c.req.param('id');if(!z.uuid().safeParse(id).success)return c.json({error:{code:'INVALID_RISK_ID',message:'id must be a UUID'}},400)
    const parsed=acknowledgeSchema.safeParse(await c.req.json().catch(()=>null));if(!parsed.success)return c.json({error:{code:'VALIDATION_ERROR',message:'Invalid acknowledgement payload',issues:parsed.error.issues}},400)
    try{const result=await engine.acknowledge({organizationId:ctx.organization.id,riskId:id,sender:parsed.data.sender});return c.json({data:{risk:serialize(result.risk),duplicate:result.duplicate,reply:result.reply}})}catch(error){return mapError(c,error)}
  })
}

async function organizationContext(c:any,organizations:OrganizationRepository):Promise<any>{const organizationId=c.req.header('x-organization-id');if(!organizationId||!z.uuid().safeParse(organizationId).success)return{response:c.json({error:{code:'INVALID_ORGANIZATION_ID',message:'A valid x-organization-id is required'}},400)};const organization=await organizations.findById(organizationId);return organization?{organization}:{response:c.json({error:{code:'ORGANIZATION_NOT_FOUND',message:'Organization not found'}},404)}}
function optionalUuid(value:string|undefined):string|Response|undefined{if(value===undefined||value==='')return undefined;if(!z.uuid().safeParse(value).success)return new Response(JSON.stringify({error:{code:'INVALID_UUID',message:'query id must be a UUID'}}),{status:400,headers:{'content-type':'application/json'}});return value}
function enumQuery<T extends string>(value:string|undefined,allowed:readonly T[]):T|'__invalid'|undefined{if(value===undefined||value==='')return undefined;return allowed.includes(value as T)?value as T:'__invalid'}
function numberQuery(value:string|undefined,fallback:number,min:number,max:number):number{const n=Number.parseInt(value??'',10);return Number.isInteger(n)&&n>=min?Math.min(n,max):fallback}
function mapError(c:any,error:unknown){if(error instanceof RiskNotFoundError)return c.json({error:{code:error.code,message:error.message}},404);if(error instanceof RiskConflictError)return c.json({error:{code:error.code,message:error.message}},409);if(error instanceof RiskValidationError)return c.json({error:{code:error.code,message:error.message}},400);throw error}
function serialize(risk:EventRisk){return{id:risk.id,eventId:risk.eventId,riskKey:risk.riskKey,type:risk.type,severity:risk.severity,score:risk.score,status:risk.status,sourceType:risk.sourceType,sourceId:risk.sourceId,title:risk.title,description:risk.description,metadata:risk.metadata,firstDetectedAt:risk.firstDetectedAt.toISOString(),lastDetectedAt:risk.lastDetectedAt.toISOString(),acknowledgedAt:risk.acknowledgedAt?.toISOString()??null,acknowledgedBy:risk.acknowledgedBy,resolvedAt:risk.resolvedAt?.toISOString()??null}}
