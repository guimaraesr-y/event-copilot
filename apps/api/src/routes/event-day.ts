import type { Hono } from 'hono'
import { z } from 'zod'
import type { OrganizationRepository } from '@ecc/database'
import { EventDayConflictError, EventDayNotFoundError, EventDayValidationError, type EventDaySnapshot } from '@ecc/domain'
import type { EventDayEngine } from '@ecc/event-engine'

const senderSchema=z.object({sender:z.string().trim().min(2).max(160).default('api')}).optional()
const taskSchema=z.object({
  sender:z.string().trim().min(2).max(160).default('api'),
  title:z.string().trim().min(2).max(200),
  description:z.string().trim().max(2000).nullable().optional(),
  kind:z.enum(['checklist','operation','incident']).default('operation'),
  priority:z.enum(['low','normal','high','critical']).optional(),
  dueAt:z.iso.datetime({offset:true}).optional(),
})

export function registerEventDayRoutes(app:Hono,organizations:OrganizationRepository,engine:EventDayEngine):void{
  app.get('/api/v1/events/:eventId/event-day',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    try{return c.json({data:serialize(await engine.get(ctx.organization.id,eventId))})}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/enable',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid Event Day enable payload',body.error.issues)
    try{const result=await engine.enable({organizationId:ctx.organization.id,eventId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}},result.duplicate?200:201)}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/disable',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid Event Day disable payload',body.error.issues)
    try{const result=await engine.disable({organizationId:ctx.organization.id,eventId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}})}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/start',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid Event Day start payload',body.error.issues)
    try{const result=await engine.start({organizationId:ctx.organization.id,eventId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}},result.duplicate?200:201)}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/vendors/:eventVendorId/arrive',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const ids=validVendorIds(c);if(ids instanceof Response)return ids
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid vendor arrival payload',body.error.issues)
    try{const result=await engine.markVendorArrived({organizationId:ctx.organization.id,eventId:ids.eventId,eventVendorId:ids.eventVendorId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}},result.duplicate?200:201)}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/vendors/:eventVendorId/depart',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const ids=validVendorIds(c);if(ids instanceof Response)return ids
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid vendor departure payload',body.error.issues)
    try{const result=await engine.markVendorDeparted({organizationId:ctx.organization.id,eventId:ids.eventId,eventVendorId:ids.eventVendorId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}},result.duplicate?200:201)}catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/tasks',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    const body=taskSchema.safeParse(await c.req.json().catch(()=>null));if(!body.success)return invalid(c,'Invalid Event Day task payload',body.error.issues)
    try{
      const result=await engine.createTask({organizationId:ctx.organization.id,eventId,sender:body.data.sender,title:body.data.title,description:body.data.description??null,kind:body.data.kind,priority:body.data.priority,dueAt:body.data.dueAt?new Date(body.data.dueAt):undefined})
      return c.json({data:{task:result.task,snapshot:serialize(result.snapshot),duplicate:result.duplicate}},201)
    }catch(error){return mapError(c,error)}
  })

  app.post('/api/v1/events/:eventId/event-day/tasks/:taskId/start',async c=>taskAction(c,organizations,engine,'start'))
  app.post('/api/v1/events/:eventId/event-day/tasks/:taskId/complete',async c=>taskAction(c,organizations,engine,'complete'))
  app.post('/api/v1/events/:eventId/event-day/tasks/:taskId/cancel',async c=>taskAction(c,organizations,engine,'cancel'))
  app.post('/api/v1/events/:eventId/event-day/incidents/:taskId/resolve',async c=>taskAction(c,organizations,engine,'resolve'))

  app.post('/api/v1/events/:eventId/event-day/complete',async c=>{
    const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
    const eventId=validEventId(c);if(eventId instanceof Response)return eventId
    const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid Event Day completion payload',body.error.issues)
    try{const result=await engine.complete({organizationId:ctx.organization.id,eventId,sender:body.data?.sender??'api'});return c.json({data:{snapshot:serialize(result.snapshot),duplicate:result.duplicate}})}catch(error){return mapError(c,error)}
  })
}

async function taskAction(c:any,organizations:OrganizationRepository,engine:EventDayEngine,action:'start'|'complete'|'cancel'|'resolve'){
  const ctx=await context(c,organizations);if('response'in ctx)return ctx.response
  const ids=validTaskIds(c);if(ids instanceof Response)return ids
  const body=senderSchema.safeParse(await c.req.json().catch(()=>undefined));if(!body.success)return invalid(c,'Invalid Event Day task action payload',body.error.issues)
  const input={organizationId:ctx.organization.id,eventId:ids.eventId,taskId:ids.taskId,sender:body.data?.sender??'api'}
  try{
    const result=action==='start'?await engine.startTask(input):action==='complete'?await engine.completeTask(input):action==='cancel'?await engine.cancelTask(input):await engine.resolveIncident(input)
    return c.json({data:{task:result.task,snapshot:serialize(result.snapshot),duplicate:result.duplicate}})
  }catch(error){return mapError(c,error)}
}

async function context(c:any,organizations:OrganizationRepository):Promise<any>{
  const organizationId=c.req.header('x-organization-id')
  if(!organizationId||!z.uuid().safeParse(organizationId).success)return{response:c.json({error:{code:'INVALID_ORGANIZATION_ID',message:'A valid x-organization-id is required'}},400)}
  const organization=await organizations.findById(organizationId)
  return organization?{organization}:{response:c.json({error:{code:'ORGANIZATION_NOT_FOUND',message:'Organization not found'}},404)}
}
function validEventId(c:any):string|Response{const id=c.req.param('eventId');return z.uuid().safeParse(id).success?id:c.json({error:{code:'INVALID_EVENT_ID',message:'eventId must be a UUID'}},400)}
function validVendorIds(c:any):{eventId:string;eventVendorId:string}|Response{
  const eventId=c.req.param('eventId'),eventVendorId=c.req.param('eventVendorId')
  if(!z.uuid().safeParse(eventId).success||!z.uuid().safeParse(eventVendorId).success)return c.json({error:{code:'INVALID_ID',message:'eventId and eventVendorId must be UUIDs'}},400)
  return{eventId,eventVendorId}
}
function validTaskIds(c:any):{eventId:string;taskId:string}|Response{
  const eventId=c.req.param('eventId'),taskId=c.req.param('taskId')
  if(!z.uuid().safeParse(eventId).success||!z.uuid().safeParse(taskId).success)return c.json({error:{code:'INVALID_ID',message:'eventId and taskId must be UUIDs'}},400)
  return{eventId,taskId}
}
function serialize(value:EventDaySnapshot){return value}
function invalid(c:any,message:string,issues:unknown){return c.json({error:{code:'VALIDATION_ERROR',message,issues}},400)}
function mapError(c:any,error:unknown){
  if(error instanceof EventDayNotFoundError)return c.json({error:{code:error.code,message:error.message}},404)
  if(error instanceof EventDayValidationError)return c.json({error:{code:error.code,message:error.message}},422)
  if(error instanceof EventDayConflictError)return c.json({error:{code:error.code,message:error.message}},409)
  throw error
}
