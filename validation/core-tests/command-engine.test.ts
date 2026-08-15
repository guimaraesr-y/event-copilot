import type {
  CommandRequest, CommandStore, ConversationContext, CreateCommandRequestInput, DomainEvent, Event, EventMilestone,
  EventNote, EventStore, EventTask, EventTemplateSnapshot, UpdateCommandRequestInput, Vendor, VendorStore, EventVendor,
} from '../../packages/domain/src/index.ts'
import { CommandEngine } from '../../packages/event-engine/src/command-engine.ts'
import { RuleBasedCommandInterpreter } from '../../packages/event-engine/src/command-interpreter.ts'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

function assert(ok: unknown, msg: string): asserts ok { if (!ok) throw new Error(`Assertion failed: ${msg}`) }
const nowDate=new Date('2026-08-15T03:00:00.000Z')
const now=()=>nowDate

class EStore implements EventStore {
  event:Event={id:'11111111-1111-4111-8111-111111111111',organizationId:'org-1',templateId:null,name:'Ana & Pedro',type:'wedding',startAt:new Date('2026-10-17T20:30:00Z'),endAt:null,venueName:null,venueAddress:null,guestCount:132,status:'planning',healthScore:100,ownerUserId:null,createdAt:nowDate,updatedAt:nowDate}
  tasks:EventTask[]=[]; outbox:DomainEvent[]=[]
  async findTemplateSnapshot(_o:string,_t:string):Promise<EventTemplateSnapshot|null>{return null}
  async createEventWithPlan(_e:Event,_t:EventTask[],_m:EventMilestone[],_d:DomainEvent[]){}
  async findEventById(o:string,id:string){return o===this.event.organizationId&&id===this.event.id?this.event:null}
  async listEvents(o:string){return o===this.event.organizationId?[this.event]:[]}
  async listEventTasks(o:string,e:string){return this.tasks.filter(t=>t.organizationId===o&&t.eventId===e)}
  async listEventMilestones(){return []}
  async createTaskWithOutbox(task:EventTask,event:DomainEvent){this.tasks.push(task);this.outbox.push(event)}
  async updateTaskWithOutbox(task:EventTask,event:DomainEvent){const i=this.tasks.findIndex(t=>t.id===task.id);if(i>=0)this.tasks[i]=task;this.outbox.push(event)}
  async findTaskById(o:string,e:string,id:string){return this.tasks.find(t=>t.organizationId===o&&t.eventId===e&&t.id===id)??null}
  async findTaskBySourceCommandRequestId(o:string,c:string){return this.tasks.find(t=>t.organizationId===o&&t.sourceCommandRequestId===c)??null}
}
class VStore implements VendorStore {
  vendors:EventVendor[]=[]
  constructor(private readonly event:Event){}
  async createVendor(_v:Vendor){} async findVendorById(){return null} async listVendors(){return []}
  async findEventById(o:string,e:string){return o===this.event.organizationId&&e===this.event.id?this.event:null}
  async findEventVendorById(){return null} async findEventVendorByVendorId(){return null}
  async listEventVendors(o:string,e:string){return this.vendors.filter(v=>v.organizationId===o&&v.eventId===e)}
  async createEventVendorWithOutbox(){} async updateEventVendorWithOutbox(){}
}
class CStore implements CommandStore {
  requests=new Map<string,CommandRequest>(); contexts=new Map<string,ConversationContext>(); notes:EventNote[]=[]; noteOutbox:DomainEvent[]=[]
  async createRequestIfAbsent(input:CreateCommandRequestInput){
    const k=`${input.organizationId}:${input.idempotencyKey}`; const old=this.requests.get(k); if(old)return{request:old,created:false}
    const req:CommandRequest={id:input.id,organizationId:input.organizationId,sender:input.sender,idempotencyKey:input.idempotencyKey,rawText:input.rawText,explicitEventId:input.explicitEventId??null,resolvedEventId:null,interpreter:input.interpreter,intent:null,confidence:null,status:'received',interpretation:null,result:null,createdAt:input.now,updatedAt:input.now,processedAt:null,lastError:null};this.requests.set(k,req);return{request:req,created:true}
  }
  private byId(o:string,id:string){return [...this.requests.values()].find(r=>r.organizationId===o&&r.id===id)}
  async findRequestById(o:string,id:string){return this.byId(o,id)??null}
  async updateRequest(o:string,id:string,input:UpdateCommandRequestInput){const req=this.byId(o,id);if(!req)throw new Error('missing');Object.assign(req,{...('resolvedEventId'in input?{resolvedEventId:input.resolvedEventId??null}:{}),...('intent'in input?{intent:input.intent??null}:{}),...('confidence'in input?{confidence:input.confidence??null}:{}),...(input.status?{status:input.status}:{}),...('interpretation'in input?{interpretation:input.interpretation??null}:{}),...('result'in input?{result:input.result??null}:{}),...('processedAt'in input?{processedAt:input.processedAt??null}:{}),...('lastError'in input?{lastError:input.lastError??null}:{}),updatedAt:input.updatedAt});return req}
  async getConversationContext(o:string,s:string){return this.contexts.get(`${o}:${s}`)??null}
  async setConversationContext(o:string,s:string,e:string|null,at:Date){const k=`${o}:${s}`;const old=this.contexts.get(k);const c:ConversationContext=old?{...old,currentEventId:e,lastInteractionAt:at,updatedAt:at}:{id:'ctx-1',organizationId:o,sender:s,currentEventId:e,lastInteractionAt:at,createdAt:at,updatedAt:at};this.contexts.set(k,c);return c}
  async countOpenInbox(){return 0}
  async findNoteByCommandRequestId(o:string,c:string){return this.notes.find(n=>n.organizationId===o&&n.sourceCommandRequestId===c)??null}
  async createNoteWithOutbox(note:EventNote,event:DomainEvent){const old=await this.findNoteByCommandRequestId(note.organizationId,note.sourceCommandRequestId);if(old)return old;this.notes.push(note);this.noteOutbox.push(event);return note}
}

const es=new EStore(); const vs=new VStore(es.event); const cs=new CStore(); let id=0
const engine=new CommandEngine({store:cs,eventEngine:new EventEngine({store:es,now,newId:()=>`event-generated-${++id}`}),vendorEngine:new VendorEngine({store:vs,now,newId:()=>`vendor-generated-${++id}`}),interpreter:new RuleBasedCommandInterpreter(),now,newId:()=>`command-generated-${++id}`})

{
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Selecione o evento Ana & Pedro',idempotencyKey:'ctx-1'})
 assert(r.request.status==='processed'&&cs.contexts.get('org-1:planner')?.currentEventId===es.event.id,'sets conversation context')
}
let taskId=''
{
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Crie uma tarefa para confirmar o buffet amanhã às 10h',idempotencyKey:'task-1'})
 assert(r.request.status==='processed'&&es.tasks.length===1,'creates task through EventEngine')
 assert(es.tasks[0]!.dueAt.toISOString()==='2026-08-16T13:00:00.000Z','task due date uses org timezone')
 assert(es.tasks[0]!.source==='automation'&&es.tasks[0]!.sourceCommandRequestId===r.request.id,'rule command is traceable and non-manual')
 taskId=es.tasks[0]!.id
 const retry=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Crie uma tarefa para confirmar o buffet amanhã às 10h',idempotencyKey:'task-1'})
 assert(retry.duplicate&&es.tasks.length===1,'command idempotency prevents duplicate task')
}
{
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Como está o evento?',idempotencyKey:'status-1'})
 assert(r.request.status==='processed'&&r.result.openTasks===1,'event status query uses conversation context')
}
{
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Conclua a tarefa confirmar o buffet',idempotencyKey:'complete-1'})
 assert(r.request.status==='processed'&&es.tasks.find(t=>t.id===taskId)?.status==='completed','completes matching task safely')
}
{
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Adicione uma observação dizendo que a avó da noiva precisa de acesso facilitado',idempotencyKey:'note-1'})
 assert(r.request.status==='processed'&&cs.notes.length===1&&cs.noteOutbox[0]?.eventType==='event.note_added','adds event note with outbox')
}
{
 const before=es.event.startAt.toISOString()
 const r=await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Mude o horário do casamento da Ana para 17h',idempotencyKey:'sensitive-1'})
 assert(r.request.status==='rejected'&&r.result.requiresChangeProposal===true,'sensitive mutation is rejected for future change proposal')
 assert(es.event.startAt.toISOString()===before,'sensitive command does not mutate event')
}

{
 let rejected=false
 try {
   await engine.execute({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner',text:'Texto diferente usando a mesma chave',idempotencyKey:'task-1'})
 } catch { rejected=true }
 assert(rejected,'idempotency key cannot be reused for a different payload')
}

console.log('CommandEngine: 8/8 behavioral scenarios passed')
