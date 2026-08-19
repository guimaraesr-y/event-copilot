import type { Hono } from 'hono'
import { z } from 'zod'
import type { OrganizationRepository } from '@ecc/database'
import { HealthNotFoundError, HealthValidationError, type EventHealthCurrent, type EventHealthEvaluation } from '@ecc/domain'
import type { HealthEngine } from '@ecc/event-engine'

const evaluateSchema = z.object({ idempotencyKey: z.string().min(1).max(160).optional() }).optional()

export function registerHealthScoreRoutes(app:Hono, organizations:OrganizationRepository, engine:HealthEngine):void {
  app.get('/api/v1/health-scores/workspace', async (c) => {
    const ctx=await organizationContext(c,organizations); if('response' in ctx)return ctx.response
    const data=await engine.workspace(ctx.organization.id, numberQuery(c.req.query('limit'),30,1,100))
    return c.json({data:data.map(serializeCurrent)})
  })
  app.get('/api/v1/events/:eventId/health-score', async (c) => {
    const ctx=await organizationContext(c,organizations); if('response' in ctx)return ctx.response
    const eventId=c.req.param('eventId'); if(!z.uuid().safeParse(eventId).success)return c.json({error:{code:'INVALID_EVENT_ID',message:'eventId must be a UUID'}},400)
    try{return c.json({data:serializeCurrent(await engine.getCurrent(ctx.organization.id,eventId))})}catch(error){return mapError(c,error)}
  })
  app.get('/api/v1/events/:eventId/health-score/history', async (c) => {
    const ctx=await organizationContext(c,organizations); if('response' in ctx)return ctx.response
    const eventId=c.req.param('eventId'); if(!z.uuid().safeParse(eventId).success)return c.json({error:{code:'INVALID_EVENT_ID',message:'eventId must be a UUID'}},400)
    try{const rows=await engine.history(ctx.organization.id,eventId,numberQuery(c.req.query('limit'),30,1,100)); return c.json({data:rows.map(serializeEvaluation)})}catch(error){return mapError(c,error)}
  })
  app.post('/api/v1/events/:eventId/health-score/evaluate', async (c) => {
    const ctx=await organizationContext(c,organizations); if('response' in ctx)return ctx.response
    const eventId=c.req.param('eventId'); if(!z.uuid().safeParse(eventId).success)return c.json({error:{code:'INVALID_EVENT_ID',message:'eventId must be a UUID'}},400)
    const parsed=evaluateSchema.safeParse(await c.req.json().catch(()=>undefined)); if(!parsed.success)return c.json({error:{code:'VALIDATION_ERROR',message:'Invalid health evaluation payload',issues:parsed.error.issues}},400)
    try{const result=await engine.evaluateEvent({organizationId:ctx.organization.id,eventId,triggerType:'manual',triggerKey:`manual:${parsed.data?.idempotencyKey??crypto.randomUUID()}`});return c.json({data:{evaluation:serializeEvaluation(result.evaluation),duplicate:result.duplicate,changed:result.changed}})}catch(error){return mapError(c,error)}
  })
}

async function organizationContext(c:any,organizations:OrganizationRepository):Promise<any>{const organizationId=c.req.header('x-organization-id');if(!organizationId||!z.uuid().safeParse(organizationId).success)return{response:c.json({error:{code:'INVALID_ORGANIZATION_ID',message:'A valid x-organization-id is required'}},400)};const organization=await organizations.findById(organizationId);return organization?{organization}:{response:c.json({error:{code:'ORGANIZATION_NOT_FOUND',message:'Organization not found'}},404)}}
function numberQuery(value:string|undefined,fallback:number,min:number,max:number):number{const n=Number.parseInt(value??'',10);return Number.isInteger(n)&&n>=min?Math.min(n,max):fallback}
function mapError(c:any,error:unknown){if(error instanceof HealthNotFoundError)return c.json({error:{code:error.code,message:error.message}},404);if(error instanceof HealthValidationError)return c.json({error:{code:error.code,message:error.message}},400);throw error}
function serializeCurrent(row:EventHealthCurrent){return{eventId:row.event.id,eventName:row.event.name,eventStartAt:row.event.startAt.toISOString(),eventStatus:row.event.status,score:row.score,status:row.status,delta:row.delta,evaluatedAt:row.evaluatedAt?.toISOString()??null,breakdown:row.breakdown}}
function serializeEvaluation(row:EventHealthEvaluation){return{id:row.id,eventId:row.eventId,triggerType:row.triggerType,triggerKey:row.triggerKey,previousScore:row.previousScore,score:row.score,delta:row.delta,status:row.status,breakdown:row.breakdown,evaluatedAt:row.evaluatedAt.toISOString()}}
