import { MessagingEngine } from '../../packages/event-engine/src/messaging-engine.ts'
import type {
  AutomationActionRef, ClaimMessageResult, DomainEvent, MessageProviderName, MessageStore,
  OutboundMessage, ProviderStatusInput, SendResult,
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
  async findAutomationAction(id:string){ return this.action?.id===id ? this.action : null }
  async getOrganizationTimezone(){ return 'America/Sao_Paulo' }
  async findMessageBySourceAction(id:string){ return this.message?.sourceActionId===id ? this.message : null }
  async findMessageById(id:string){ return this.message?.id===id ? this.message : null }
  async findMessageByExternalId(provider:MessageProviderName,id:string){ return this.message?.provider===provider && this.message.externalMessageId===id ? this.message : null }
  async createMessageWithOutbox(message:OutboundMessage,event:DomainEvent){ if(this.message) return {message:this.message,created:false}; this.message=message; this.outbox.push(event); if(this.action)this.action.status='processing'; return {message,created:true} }
  async claimForSend(id:string):Promise<ClaimMessageResult|null>{ if(!this.message||this.message.id!==id)return null; if(['sent','delivered','read'].includes(this.message.status))return {state:'already_sent',message:this.message}; if(this.message.status==='sending')return {state:'in_progress',message:this.message}; this.message={...this.message,status:'sending'}; return {state:'claimed',message:this.message} }
  async markSent(_id:string,external:string,response:Record<string,unknown>|null,at:Date,event:DomainEvent){ this.message={...this.message!,status:'sent',externalMessageId:external,providerResponse:response,sentAt:at,updatedAt:at}; this.action!.status='completed'; this.outbox.push(event); return this.message }
  async markFailed(_id:string,error:string,at:Date,event:DomainEvent){ this.message={...this.message!,status:'failed',failedAt:at,lastError:error,updatedAt:at}; this.action!.status='failed'; this.outbox.push(event); return this.message }
  async applyProviderStatus(input:ProviderStatusInput,event:DomainEvent){ if(!this.message)return null; const rank:any={sent:2,delivered:3,read:4}; if(input.status!=='failed' && (rank[input.status]??-1) <= (rank[this.message.status]??-1)) return {message:this.message,changed:false}; this.message={...this.message,status:input.status,updatedAt:input.occurredAt,deliveredAt:input.status==='delivered'||input.status==='read'?input.occurredAt:this.message.deliveredAt,readAt:input.status==='read'?input.occurredAt:this.message.readAt}; this.outbox.push(event); return {message:this.message,changed:true} }
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

const store=new Store(); const provider=new Provider(); const engine=new MessagingEngine({store,provider,now,newId})
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

console.log('MessagingEngine: 6/6 behavioral scenarios passed')
