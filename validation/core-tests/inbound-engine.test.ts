import { InboundEngine } from '../../packages/event-engine/src/inbound-engine.ts'
import { RuleBasedSupplierResponseInterpreter } from '../../packages/event-engine/src/supplier-response-interpreter.ts'
import type { InboundMessage, InboundMessageStore, InboundProcessingContext, SupplierResponseInterpretation, VendorStore, Vendor, EventVendor, Event, DomainEvent } from '../../packages/domain/src/index.ts'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

const assert=(ok:boolean,msg:string)=>{ if(!ok) throw new Error(msg) }
const nowDate=new Date('2026-08-11T14:30:00.000Z')
const now=()=>nowDate

class InStore implements InboundMessageStore {
  constructor(public message:InboundMessage, public context:InboundProcessingContext|null){}
  async findById(id:string){ return this.message.id===id?this.message:null }
  async getProcessingContext(){ return this.context }
  async markProcessing(_id:string,at:Date){ this.message={...this.message,status:'processing',updatedAt:at}; return this.message }
  async markProcessed(_id:string,i:SupplierResponseInterpretation,at:Date){ this.message={...this.message,status:'processed',interpretation:i,processedAt:at,updatedAt:at,lastError:null}; return this.message }
  async markNeedsReview(_id:string,i:SupplierResponseInterpretation|null,reason:string,at:Date){ this.message={...this.message,status:'needs_review',interpretation:i,processedAt:at,updatedAt:at,lastError:reason}; return this.message }
  async markFailed(_id:string,reason:string,at:Date){ this.message={...this.message,status:'failed',processedAt:at,updatedAt:at,lastError:reason}; return this.message }
}

class VStore implements VendorStore {
  assignment:EventVendor
  outbox:DomainEvent[]=[]
  constructor(){ this.assignment={
    id:'ev-1',organizationId:'org-1',eventId:'event-1',vendorId:'vendor-1',vendorName:'Luz Foto',category:'photo',contactName:'Ryan',phone:'+5521999999999',email:null,
    confirmationStatus:'requested',contractStatus:'signed',paymentStatus:'partial',arrivalAt:null,departureAt:null,teamSize:null,
    confirmationRequestedAt:new Date('2026-08-11T14:00:00Z'),confirmationDeadlineAt:null,confirmedAt:null,declinedAt:null,notes:null,
    createdAt:nowDate,updatedAt:nowDate,
  }}
  async createVendor(_v:Vendor){}
  async findVendorById(){return null}
  async listVendors(){return []}
  async findEventById():Promise<Event|null>{return null}
  async findEventVendorById(_o:string,_e:string,id:string){return id===this.assignment.id?this.assignment:null}
  async findEventVendorByVendorId(){return null}
  async listEventVendors(){return [this.assignment]}
  async createEventVendorWithOutbox(){}
  async updateEventVendorWithOutbox(v:EventVendor,e:DomainEvent){this.assignment=v;this.outbox.push(e)}
}

function inbound(text:string):InboundMessage { return {
  id:'in-1',organizationId:'org-1',webhookEventId:'wh-1',provider:'meta',externalMessageId:'wamid-in-1',sender:'5521999999999',recipient:'5521888888888',
  content:{type:'text',text},status:'resolved',resolvedEventId:'event-1',resolvedEventVendorId:'ev-1',candidateEventVendorIds:['ev-1'],interpretation:null,
  receivedAt:nowDate,processedAt:null,createdAt:nowDate,updatedAt:nowDate,lastError:null,
}}
const context:InboundProcessingContext={organizationId:'org-1',eventId:'event-1',eventVendorId:'ev-1',vendorId:'vendor-1',eventStartAt:new Date('2026-10-17T20:30:00Z'),timezone:'America/Sao_Paulo'}

{
  const vs=new VStore(); const store=new InStore(inbound('Sim, confirmado. Chegaremos às 14:30 com 3 pessoas.'),context)
  const engine=new InboundEngine({store,vendorEngine:new VendorEngine({store:vs,now}),interpreter:new RuleBasedSupplierResponseInterpreter(),now})
  const result=await engine.process('in-1')
  assert(result.action==='confirm','confirmation interpreted')
  assert(vs.assignment.confirmationStatus==='confirmed','vendor confirmed')
  assert(vs.assignment.arrivalAt?.toISOString()==='2026-10-17T17:30:00.000Z','14:30 Sao Paulo resolved on event day')
  assert(vs.assignment.teamSize===3,'team size extracted')
  assert(store.message.status==='processed','inbound processed')
  assert(vs.outbox.filter(e=>e.eventType==='vendor.confirmed').length===1,'vendor.confirmed emitted once')
  const retry=await engine.process('in-1')
  assert(retry.duplicate && vs.outbox.filter(e=>e.eventType==='vendor.confirmed').length===1,'processed retry is idempotent')
}
{
  const vs=new VStore(); const store=new InStore(inbound('Infelizmente não poderemos atender este evento.'),context)
  const engine=new InboundEngine({store,vendorEngine:new VendorEngine({store:vs,now}),interpreter:new RuleBasedSupplierResponseInterpreter(),now})
  const result=await engine.process('in-1')
  assert(result.action==='decline' && vs.assignment.confirmationStatus==='declined','decline processed')
}
{
  const vs=new VStore(); const store=new InStore(inbound('Ainda não consigo confirmar, te respondo amanhã.'),context)
  const engine=new InboundEngine({store,vendorEngine:new VendorEngine({store:vs,now}),interpreter:new RuleBasedSupplierResponseInterpreter(),now})
  const result=await engine.process('in-1')
  assert(result.action==='needs_review' && store.message.status==='needs_review','undecided goes to review')
}
{
  const vs=new VStore(); const msg=inbound('Confirmado'); msg.content={type:'media',mediaType:'audio',mediaId:'x',caption:null}
  const store=new InStore(msg,context)
  const engine=new InboundEngine({store,vendorEngine:new VendorEngine({store:vs,now}),interpreter:new RuleBasedSupplierResponseInterpreter(),now})
  const result=await engine.process('in-1')
  assert(result.action==='needs_review','media is deferred')
}
{
  const interpreter=new RuleBasedSupplierResponseInterpreter()
  const parsed=interpreter.interpret('Chegaremos 16h com equipe de 5')
  assert(parsed.intent==='confirm' && parsed.arrivalTime==='16:00' && parsed.teamSize===5,'operational details imply confirmation')
  const unknown=interpreter.interpret('Obrigado pela mensagem')
  assert(unknown.intent==='unknown','unknown stays reviewable')
}

console.log('InboundEngine: 7/7 behavioral scenarios passed')
