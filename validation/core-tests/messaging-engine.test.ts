import { MessagingEngine } from '../../packages/event-engine/src/messaging-engine.ts'
import type {
  AutomationActionRef, CanonicalMessagingWebhookEvent, ClaimMessageResult, DomainEvent, InboundMessage, InboundResolutionCandidate, MessageProviderName, MessageStore,
  MessagingWebhookReceipt, OutboundMessage, ProviderStatusInput, RegisterWebhookEventInput, SendResult,
} from '../../packages/domain/src/index.ts'

const action: AutomationActionRef = {
  id:'10000000-0000-4000-8000-000000000001', organizationId:'10000000-0000-4000-8000-000000000002',
  actionType:'vendor_confirmation.prepare', status:'prepared', aggregateType:'event_vendor', aggregateId:'10000000-0000-4000-8000-000000000003',
  payload:{ phone:'+55 (21) 99999-9999', vendorName:'Luz Foto', eventName:'Ana & Pedro', eventStartAt:'2026-10-17T20:30:00.000Z', eventId:'10000000-0000-4000-8000-000000000004', eventVendorId:'10000000-0000-4000-8000-000000000003' },
}

class Store implements MessageStore {
  action: AutomationActionRef | null = structuredClone(action)
  message: OutboundMessage | null = null
  outbox: DomainEvent[] = []
  receipts = new Map<string, MessagingWebhookReceipt>()
  inbounds = new Map<string, InboundMessage>()

  async findAutomationAction(id:string){ return this.action?.id===id ? this.action : null }
  async getOrganizationTimezone(){ return 'America/Sao_Paulo' }
  async findMessageBySourceAction(id:string){ return this.message?.sourceActionId===id ? this.message : null }
  async findMessageById(id:string){ return this.message?.id===id ? this.message : null }
  async findMessageByExternalId(provider:MessageProviderName,id:string){ return this.message?.provider===provider && this.message.externalMessageId===id ? this.message : null }
  async createMessageWithOutbox(message:OutboundMessage,event:DomainEvent){ if(this.message) return {message:this.message,created:false}; this.message=message; this.outbox.push(event); if(this.action)this.action.status='processing'; return {message,created:true} }
  async claimForSend(id:string):Promise<ClaimMessageResult|null>{ if(!this.message||this.message.id!==id)return null; if(['sent','delivered','read'].includes(this.message.status))return {state:'already_sent',message:this.message}; if(this.message.status==='sending')return {state:'in_progress',message:this.message}; this.message={...this.message,status:'sending'}; return {state:'claimed',message:this.message} }
  async markSent(_id:string,external:string,response:Record<string,unknown>|null,at:Date,event:DomainEvent){ this.message={...this.message!,status:'sent',externalMessageId:external,providerResponse:response,sentAt:at,updatedAt:at}; this.action!.status='completed'; this.outbox.push(event); return this.message }
  async markFailed(_id:string,error:string,at:Date,event:DomainEvent){ this.message={...this.message!,status:'failed',failedAt:at,lastError:error,updatedAt:at}; this.action!.status='failed'; this.outbox.push(event); return this.message }
  async applyProviderStatus(input:ProviderStatusInput,event:DomainEvent){
    if(!this.message)return null
    const rank:Record<string,number>={sent:2,delivered:3,read:4}
    if(input.status!=='failed' && (rank[input.status]??-1) <= (rank[this.message.status]??-1)) return {message:this.message,changed:false}
    this.message={...this.message,status:input.status,updatedAt:input.occurredAt,
      deliveredAt:input.status==='delivered'||input.status==='read'?input.occurredAt:this.message.deliveredAt,
      readAt:input.status==='read'?input.occurredAt:this.message.readAt}
    this.outbox.push(event)
    return {message:this.message,changed:true}
  }

  async findInboundCandidates(sender:string):Promise<InboundResolutionCandidate[]> {
    const normalized=sender.replace(/\D/g,'')
    const first={organizationId:action.organizationId,eventId:String(action.payload.eventId),eventVendorId:action.aggregateId,vendorId:'10000000-0000-4000-8000-000000000099',outboundMessageId:this.message?.id??'outbound-1',sentAt:new Date('2026-08-10T04:00:00Z')}
    if(normalized==='5521999999999') return [first]
    if(normalized==='5521777777777') return [first,{...first,eventId:'event-2',eventVendorId:'event-vendor-2',outboundMessageId:'outbound-2'}]
    if(normalized==='5521666666666') return [first,{...first,organizationId:'30000000-0000-4000-8000-000000000001',eventId:'30000000-0000-4000-8000-000000000002',eventVendorId:'30000000-0000-4000-8000-000000000003',outboundMessageId:'outbound-cross-tenant'}]
    return []
  }
  async findInboundByProviderMessageId(provider:MessageProviderName,id:string){
    return [...this.inbounds.values()].find((m)=>m.provider===provider&&m.externalMessageId===id)??null
  }
  async createInboundMessageWithOutbox(message:InboundMessage,events:DomainEvent[]){
    const existing=await this.findInboundByProviderMessageId(message.provider,message.externalMessageId)
    if(existing)return {message:existing,created:false}
    this.inbounds.set(message.id,message); this.outbox.push(...events); return {message,created:true}
  }
  async registerWebhookEvent(input:RegisterWebhookEventInput){
    const key=`${input.event.provider}|${input.event.externalEventId}`
    const existing=this.receipts.get(key)
    if(existing) return {receipt:existing,created:false}
    const receipt:MessagingWebhookReceipt={
      id:`receipt-${this.receipts.size+1}`, provider:input.event.provider, externalEventId:input.event.externalEventId,
      eventType:input.event.type, status:'received', payloadHash:input.payloadHash,
      canonicalPayload:{type:input.event.type}, rawPayload:input.rawPayload,
      receivedAt:input.receivedAt, processedAt:null, lastError:null,
    }
    this.receipts.set(key,receipt)
    return {receipt,created:true}
  }
  async markWebhookEventProcessed(id:string,at:Date){ this.patchReceipt(id,{status:'processed',processedAt:at,lastError:null}) }
  async markWebhookEventIgnored(id:string,reason:string,at:Date){ this.patchReceipt(id,{status:'ignored',processedAt:at,lastError:reason}) }
  async markWebhookEventFailed(id:string,error:string,at:Date){ this.patchReceipt(id,{status:'failed',processedAt:at,lastError:error}) }

  private patchReceipt(id:string,patch:Partial<MessagingWebhookReceipt>){
    for(const [key,value] of this.receipts) if(value.id===id) this.receipts.set(key,{...value,...patch})
  }
}

class Provider {
  readonly name='mock' as const
  calls=0
  async send(message:OutboundMessage):Promise<SendResult>{ this.calls++; return {externalMessageId:`mock-wamid-${message.id}`,providerResponse:{ok:true}} }
}

let seq=10
const newId=()=>`20000000-0000-4000-8000-${String(seq++).padStart(12,'0')}`
const now=()=>new Date('2026-08-10T04:00:00.000Z')
const assert=(ok:boolean,msg:string)=>{ if(!ok) throw new Error(msg) }

const store=new Store()
const provider=new Provider()
const engine=new MessagingEngine({store,provider,now,newId})

const prepared=await engine.prepareVendorConfirmation(action.id)
assert(prepared.created,'message created')
assert(prepared.message.recipient==='5521999999999','phone normalized')
assert(String(prepared.message.payload.text).includes('Ana & Pedro'),'deterministic text includes event')

const duplicate=await engine.prepareVendorConfirmation(action.id)
assert(!duplicate.created && duplicate.message.id===prepared.message.id,'prepare is idempotent')

const sent=await engine.send(prepared.message.id)
assert(sent.message.status==='sent' && provider.calls===1,'provider sends once')
const sentAgain=await engine.send(prepared.message.id)
assert(sentAgain.duplicate && provider.calls===1,'sent retry does not resend')

const delivered=await engine.applyProviderStatus({provider:'mock',externalMessageId:sent.message.externalMessageId!,status:'delivered',occurredAt:new Date('2026-08-10T04:01:00Z')})
assert(delivered.changed && delivered.message.status==='delivered','delivery tracked')
const read=await engine.applyProviderStatus({provider:'mock',externalMessageId:sent.message.externalMessageId!,status:'read',occurredAt:new Date('2026-08-10T04:02:00Z')})
assert(read.changed && read.message.status==='read','read tracked')
const lateDelivered=await engine.applyProviderStatus({provider:'mock',externalMessageId:sent.message.externalMessageId!,status:'delivered',occurredAt:new Date('2026-08-10T04:03:00Z')})
assert(!lateDelivered.changed && lateDelivered.message.status==='read','status never regresses')

const statusEvent:CanonicalMessagingWebhookEvent={
  type:'message.status', provider:'mock', externalEventId:'mock:status:1',
  externalMessageId:sent.message.externalMessageId!, status:'read', occurredAt:new Date('2026-08-10T04:04:00Z'), raw:{source:'test'},
}
const handled=await engine.handleWebhookEvent({event:statusEvent,payloadHash:'hash-status',rawPayload:{source:'test'}})
assert(!handled.duplicate && handled.handled && handled.status==='processed','canonical status webhook processed')
const webhookDuplicate=await engine.handleWebhookEvent({event:statusEvent,payloadHash:'different-hash',rawPayload:{source:'retry'}})
assert(webhookDuplicate.duplicate && webhookDuplicate.status==='processed','webhook external event id is idempotent')


const originalExternal=store.message!.externalMessageId
store.message={...store.message!,externalMessageId:'other-id'}
const racedEvent:CanonicalMessagingWebhookEvent={
  type:'message.status',provider:'mock',externalEventId:'mock:raced:1',
  externalMessageId:'late-external-id',status:'delivered',occurredAt:new Date('2026-08-10T04:04:30Z'),raw:{source:'race'},
}
const racedFirst=await engine.handleWebhookEvent({event:racedEvent,payloadHash:'race-1',rawPayload:{source:'race'}})
assert(!racedFirst.duplicate && racedFirst.status==='ignored','early status without matching outbound is retryable ignored')
store.message={...store.message!,externalMessageId:'late-external-id'}
const racedRetry=await engine.handleWebhookEvent({event:racedEvent,payloadHash:'race-2',rawPayload:{source:'retry'}})
assert(racedRetry.duplicate && racedRetry.handled && racedRetry.status==='processed','ignored status retry is reprocessed after outbound id exists')
store.message={...store.message!,externalMessageId:originalExternal}

const inboundEvent:CanonicalMessagingWebhookEvent={
  type:'message.received', provider:'meta', externalEventId:'meta:abc:received',
  externalMessageId:'abc', sender:'5521999999999', recipient:'5521888888888',
  occurredAt:new Date('2026-08-10T04:05:00Z'), content:{type:'text',text:'Confirmado'}, raw:{type:'text'},
}
const inbound=await engine.handleWebhookEvent({event:inboundEvent,payloadHash:'hash-inbound',rawPayload:{object:'whatsapp_business_account'}})
assert(!inbound.duplicate && inbound.handled && inbound.status==='resolved','inbound is correlated and emits message.received')
assert([...store.inbounds.values()].length===1,'inbound message persisted')
assert(store.outbox.some((e)=>e.eventType==='message.received'),'message.received emitted for unique context')

const noContextEvent:CanonicalMessagingWebhookEvent={
  ...inboundEvent,externalEventId:'meta:none:received',externalMessageId:'none',sender:'5521000000000',
}
const noContext=await engine.handleWebhookEvent({event:noContextEvent,payloadHash:'hash-none',rawPayload:{object:'whatsapp_business_account'}})
assert(noContext.status==='ignored','inbound without pending confirmation is ignored safely')
assert([...store.inbounds.values()].some((m)=>m.externalMessageId==='none'&&m.status==='ignored'),'ignored inbound remains auditable')

const ambiguousEvent:CanonicalMessagingWebhookEvent={
  ...inboundEvent,externalEventId:'meta:ambiguous:received',externalMessageId:'ambiguous',sender:'5521777777777',
}
const ambiguous=await engine.handleWebhookEvent({event:ambiguousEvent,payloadHash:'hash-ambiguous',rawPayload:{object:'whatsapp_business_account'}})
assert(ambiguous.status==='needs_review','ambiguous inbound never chooses an event silently')
assert([...store.inbounds.values()].some((m)=>m.externalMessageId==='ambiguous'&&m.candidateEventVendorIds.length===2),'ambiguous candidates are persisted for review')
assert(store.outbox.some((e)=>e.eventType==='message.review_required'&&e.aggregateType==='inbound_message'),'ambiguous inbound emits review-required operational event')

const crossTenantEvent:CanonicalMessagingWebhookEvent={
  ...inboundEvent,externalEventId:'meta:cross-tenant:received',externalMessageId:'cross-tenant',sender:'5521666666666',
}
const beforeCrossTenant=store.outbox.length
const crossTenant=await engine.handleWebhookEvent({event:crossTenantEvent,payloadHash:'hash-cross',rawPayload:{object:'whatsapp_business_account'}})
assert(crossTenant.status==='needs_review','cross-tenant ambiguity requires review')
const reviewEvents=store.outbox.slice(beforeCrossTenant).filter((e)=>e.eventType==='message.review_required')
assert(reviewEvents.length===2 && reviewEvents.every((e)=>Array.isArray(e.payload.candidateEventVendorIds)&&e.payload.candidateEventVendorIds.length===1),'cross-tenant review events isolate candidate ids per organization')

console.log('MessagingEngine: 18/18 behavioral scenarios passed')
