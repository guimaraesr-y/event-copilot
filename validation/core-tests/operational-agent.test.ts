import type {
  AgentTurn, AgentTurnStore, CommandRequest, CommandStore, ConversationContext, CreateAgentTurnInput, CreateCommandRequestInput,
  DomainEvent, Event, EventMilestone, EventNote, EventStore, EventTask, EventTemplateSnapshot, EventVendor, UpdateAgentTurnInput,
  UpdateCommandRequestInput, Vendor, VendorStore,
} from '../../packages/domain/src/index.ts'
import { CommandEngine } from '../../packages/event-engine/src/command-engine.ts'
import { RuleBasedCommandInterpreter } from '../../packages/event-engine/src/command-interpreter.ts'
import { EventEngine } from '../../packages/event-engine/src/event-engine.ts'
import { OperationalAgent } from '../../packages/event-engine/src/operational-agent.ts'
import type { AgentProviderMessage, AgentProviderResponse, AgentToolDefinition, OperationalAgentProvider } from '../../packages/event-engine/src/operational-agent-provider.ts'
import { VendorEngine } from '../../packages/event-engine/src/vendor-engine.ts'

function assert(ok: unknown, msg: string): asserts ok { if (!ok) throw new Error(`Assertion failed: ${msg}`) }
const fixedNow = new Date('2026-08-17T21:30:00.000Z')
const now = () => fixedNow
const ANA = '11111111-1111-4111-8111-111111111111'
const LAURA = '22222222-2222-4222-8222-222222222222'

function event(id: string, name: string, type: Event['type'], startAt: string): Event {
  return { id, organizationId:'org-1',templateId:null,name,type,startAt:new Date(startAt),endAt:null,venueName:null,venueAddress:null,guestCount:100,status:'planning',healthScore:100,ownerUserId:null,createdAt:fixedNow,updatedAt:fixedNow }
}

class EStore implements EventStore {
  events=[event(ANA,'Ana & Pedro','wedding','2026-10-17T20:30:00Z'),event(LAURA,'Laura 15 anos','birthday','2026-10-24T22:00:00Z')]
  tasks:EventTask[]=[]; outbox:DomainEvent[]=[]
  async findTemplateSnapshot(_o:string,_t:string):Promise<EventTemplateSnapshot|null>{return null}
  async createEventWithPlan(_e:Event,_t:EventTask[],_m:EventMilestone[],_d:DomainEvent[]){}
  async findEventById(o:string,id:string){return this.events.find(e=>e.organizationId===o&&e.id===id)??null}
  async listEvents(o:string){return this.events.filter(e=>e.organizationId===o)}
  async listEventTasks(o:string,e:string){return this.tasks.filter(t=>t.organizationId===o&&t.eventId===e)}
  async listEventMilestones(){return []}
  async createTaskWithOutbox(task:EventTask,domainEvent:DomainEvent){this.tasks.push(task);this.outbox.push(domainEvent)}
  async updateTaskWithOutbox(task:EventTask,domainEvent:DomainEvent){const i=this.tasks.findIndex(t=>t.id===task.id);if(i>=0)this.tasks[i]=task;this.outbox.push(domainEvent)}
  async findTaskById(o:string,e:string,id:string){return this.tasks.find(t=>t.organizationId===o&&t.eventId===e&&t.id===id)??null}
  async findTaskBySourceCommandRequestId(o:string,c:string){return this.tasks.find(t=>t.organizationId===o&&t.sourceCommandRequestId===c)??null}
}
class VStore implements VendorStore {
  vendors:EventVendor[]=[]
  constructor(private readonly es:EStore){}
  async createVendor(_v:Vendor){} async findVendorById(){return null} async listVendors(){return []}
  async findEventById(o:string,e:string){return this.es.findEventById(o,e)}
  async findEventVendorById(){return null} async findEventVendorByVendorId(){return null}
  async listEventVendors(o:string,e:string){return this.vendors.filter(v=>v.organizationId===o&&v.eventId===e)}
  async createEventVendorWithOutbox(){} async updateEventVendorWithOutbox(){}
}
class CStore implements CommandStore {
  requests=new Map<string,CommandRequest>(); contexts=new Map<string,ConversationContext>(); notes:EventNote[]=[]
  async createRequestIfAbsent(input:CreateCommandRequestInput){
    const k=`${input.organizationId}:${input.idempotencyKey}`;const old=this.requests.get(k);if(old)return{request:old,created:false}
    const r:CommandRequest={id:input.id,organizationId:input.organizationId,sender:input.sender,idempotencyKey:input.idempotencyKey,rawText:input.rawText,explicitEventId:input.explicitEventId??null,resolvedEventId:null,interpreter:input.interpreter,intent:null,confidence:null,status:'received',interpretation:null,result:null,createdAt:input.now,updatedAt:input.now,processedAt:null,lastError:null};this.requests.set(k,r);return{request:r,created:true}
  }
  private byId(o:string,id:string){return [...this.requests.values()].find(r=>r.organizationId===o&&r.id===id)}
  async findRequestById(o:string,id:string){return this.byId(o,id)??null}
  async updateRequest(o:string,id:string,input:UpdateCommandRequestInput){const r=this.byId(o,id);if(!r)throw new Error('missing request');Object.assign(r,{...('resolvedEventId'in input?{resolvedEventId:input.resolvedEventId??null}:{}),...('intent'in input?{intent:input.intent??null}:{}),...('confidence'in input?{confidence:input.confidence??null}:{}),...(input.status?{status:input.status}:{}),...('interpretation'in input?{interpretation:input.interpretation??null}:{}),...('result'in input?{result:input.result??null}:{}),...('processedAt'in input?{processedAt:input.processedAt??null}:{}),...('lastError'in input?{lastError:input.lastError??null}:{}),updatedAt:input.updatedAt});return r}
  async getConversationContext(o:string,s:string){return this.contexts.get(`${o}:${s}`)??null}
  async setConversationContext(o:string,s:string,e:string|null,at:Date){const k=`${o}:${s}`;const old=this.contexts.get(k);const c:ConversationContext=old?{...old,currentEventId:e,lastInteractionAt:at,updatedAt:at}:{id:`ctx-${this.contexts.size+1}`,organizationId:o,sender:s,currentEventId:e,lastInteractionAt:at,createdAt:at,updatedAt:at};this.contexts.set(k,c);return c}
  async countOpenInbox(){return 0}
  async findNoteByCommandRequestId(o:string,c:string){return this.notes.find(n=>n.organizationId===o&&n.sourceCommandRequestId===c)??null}
  async createNoteWithOutbox(note:EventNote,_event:DomainEvent){const old=await this.findNoteByCommandRequestId(note.organizationId,note.sourceCommandRequestId);if(old)return old;this.notes.push(note);return note}
}
class AStore implements AgentTurnStore {
  turns=new Map<string,AgentTurn>()
  async createTurnIfAbsent(input:CreateAgentTurnInput){const k=`${input.organizationId}:${input.idempotencyKey}`;const old=this.turns.get(k);if(old)return{turn:old,created:false};const t:AgentTurn={id:input.id,organizationId:input.organizationId,sender:input.sender,idempotencyKey:input.idempotencyKey,userText:input.userText,explicitEventId:input.explicitEventId??null,assistantText:null,status:'received',provider:input.provider,model:input.model,modelCalls:0,toolTrace:[],createdAt:input.now,updatedAt:input.now,completedAt:null,lastError:null};this.turns.set(k,t);return{turn:t,created:true}}
  async updateTurn(o:string,id:string,input:UpdateAgentTurnInput){const t=[...this.turns.values()].find(t=>t.organizationId===o&&t.id===id);if(!t)throw new Error('missing turn');Object.assign(t,{...('assistantText'in input?{assistantText:input.assistantText??null}:{}),...(input.status?{status:input.status}:{}),...('modelCalls'in input?{modelCalls:input.modelCalls}:{}),...('toolTrace'in input?{toolTrace:input.toolTrace??[]}:{}),...('completedAt'in input?{completedAt:input.completedAt??null}:{}),...('lastError'in input?{lastError:input.lastError??null}:{}),updatedAt:input.updatedAt});return t}
  async listRecentTurns(o:string,s:string,limit:number){return [...this.turns.values()].filter(t=>t.organizationId===o&&t.sender===s&&t.status==='completed').sort((a,b)=>a.createdAt.getTime()-b.createdAt.getTime()).slice(-limit)}
}

class ScriptedProvider implements OperationalAgentProvider {
  readonly kind='ollama' as const; readonly model='fake-agent'; calls=0; sawHistory=false
  async complete(input:{messages:AgentProviderMessage[];tools:AgentToolDefinition[]}):Promise<AgentProviderResponse>{
    this.calls++
    const last=input.messages.at(-1)
    if(last?.role==='tool') return {message:{role:'assistant',content:`Resultado analisado de ${last.toolName}.`},toolCalls:[]}
    const user=[...input.messages].reverse().find(m=>m.role==='user')?.content??''
    this.sawHistory = this.sawHistory || input.messages.filter(m=>m.role==='user').length>1
    if(user.includes('meus eventos')) return tool('get_workspace_overview',{})
    if(user.includes('Laura')) return tool('select_event',{eventId:LAURA})
    if(user.includes('Crie uma tarefa')) return tool('create_task',{eventId:ANA,title:'Confirmar buffet',dueAt:'2026-10-01T10:00:00-03:00'})
    if(user.includes('horário')) return {message:{role:'assistant',content:'Essa mudança de horário exige uma Change Proposal e não foi aplicada.'},toolCalls:[]}
    return tool('get_event_details',{eventId:ANA})
  }
}
function tool(name:string,args:Record<string,unknown>):AgentProviderResponse{const call={name,arguments:args};return{message:{role:'assistant',content:'',toolCalls:[call]},toolCalls:[call]}}

const es=new EStore();const vs=new VStore(es);const cs=new CStore();const as=new AStore();let seq=0
const eventEngine=new EventEngine({store:es,now,newId:()=>`event-generated-${++seq}`})
const vendorEngine=new VendorEngine({store:vs,now,newId:()=>`vendor-generated-${++seq}`})
const commandEngine=new CommandEngine({store:cs,eventEngine,vendorEngine,interpreter:new RuleBasedCommandInterpreter(),now,newId:()=>`command-${++seq}`})
const provider=new ScriptedProvider()
const agent=new OperationalAgent({store:as,provider,eventEngine,vendorEngine,commandEngine,operations:{async listActivity(){return[]},async listInbox(){return[]}},now,newId:()=>`agent-${++seq}`,historyTurns:6})
const base={organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',sender:'planner'}

{
  const r=await agent.chat({...base,text:'Como estão meus eventos?',idempotencyKey:'agent-overview'})
  assert(r.turn.status==='completed'&&r.turn.toolTrace[0]?.name==='get_workspace_overview','agent uses read tool for multi-event overview')
  assert(r.turn.modelCalls===2,'tool loop records model calls')
}
{
  const r=await agent.chat({...base,text:'Vamos trabalhar no evento Laura 15 anos',idempotencyKey:'agent-laura'})
  assert(r.turn.toolTrace[0]?.name==='select_event','agent can switch event context')
  assert(cs.contexts.get('org-1:planner')?.currentEventId===LAURA,'selected event is persisted as conversation context')
  assert(provider.sawHistory,'completed turns are supplied as short conversational memory')
}
let createdTurnId=''
{
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00',idempotencyKey:'agent-task'})
  createdTurnId=r.turn.id
  assert(es.tasks.length===1&&es.tasks[0]?.title==='Confirmar buffet','agent creates task through domain engine')
  assert(es.tasks[0]?.source==='ai','agent-created task is marked as AI source')
  const request=[...cs.requests.values()].find(req=>req.id===es.tasks[0]?.sourceCommandRequestId)
  assert(request?.interpreter==='agent'&&request.status==='processed','write delegates to structured CommandEngine path')
  assert(r.turn.modelCalls===1,'write finishes from deterministic CommandEngine reply without a second model call')
}
{
  const beforeCalls=provider.calls
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Crie uma tarefa para confirmar o buffet em 2026-10-01T10:00:00-03:00',idempotencyKey:'agent-task'})
  assert(r.duplicate&&r.turn.id===createdTurnId,'completed turn retry is idempotent')
  assert(es.tasks.length===1&&provider.calls===beforeCalls,'idempotent retry performs no model or tool call')
}
{
  const before=es.events[0]!.startAt.toISOString();const taskCount=es.tasks.length
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Mude o horário do casamento para 17h',idempotencyKey:'agent-sensitive'})
  assert(r.reply.includes('Change Proposal'),'agent refuses sensitive write without a tool')
  assert(es.events[0]!.startAt.toISOString()===before&&es.tasks.length===taskCount,'sensitive conversational request cannot mutate domain')
}
{
  const {turn}=await as.createTurnIfAbsent({id:'stuck-turn',organizationId:'org-1',sender:'planner',idempotencyKey:'stuck-key',userText:'Como estão meus eventos?',provider:'ollama',model:'fake',now:fixedNow})
  await as.updateTurn('org-1',turn.id,{status:'processing',updatedAt:fixedNow})
  let conflict=false
  try{await agent.chat({...base,text:'Como estão meus eventos?',idempotencyKey:'stuck-key'})}catch(error){conflict=typeof error==='object'&&error!==null&&'code'in error&&(error as {code?:unknown}).code==='OPERATIONAL_AGENT_TURN_CONFLICT'}
  assert(conflict,'incomplete turn is never automatically replayed')
}

console.log('OperationalAgent: 6/6 behavioral scenarios passed')
