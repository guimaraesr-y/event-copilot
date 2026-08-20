import type {
  AgentTurn, AgentTurnStore, ChangeProposal, ChangeProposalImpact, ChangeProposalStore, ChangeProposalWithImpacts, CommandRequest, CommandStore, ConversationContext, CreateAgentTurnInput, CreateCommandRequestInput,
  DomainEvent, Event, EventMilestone, EventNote, EventStore, EventTask, EventTemplateSnapshot, EventVendor, ListChangeProposalsInput, UpdateAgentTurnInput,
  UpdateCommandRequestInput, Vendor, VendorStore,
} from '../../packages/domain/src/index.ts'
import { ChangeProposalEngine } from '../../packages/event-engine/src/change-proposal-engine.ts'
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

class CPStore implements ChangeProposalStore {
  values=new Map<string,ChangeProposalWithImpacts>()
  constructor(private readonly es:EStore){}
  async findById(o:string,id:string){const v=this.values.get(id);return v?.proposal.organizationId===o?v:null}
  async findByIdempotencyKey(o:string,key:string){return [...this.values.values()].find(v=>v.proposal.organizationId===o&&v.proposal.idempotencyKey===key)??null}
  async list(input:ListChangeProposalsInput){return [...this.values.values()].filter(v=>v.proposal.organizationId===input.organizationId&&(!input.eventId||v.proposal.eventId===input.eventId)&&(!input.status||v.proposal.status===input.status)&&(!input.requestedBySender||v.proposal.requestedBySender===input.requestedBySender)).slice(0,input.limit??50)}
  async createWithOutbox(p:ChangeProposal,i:ChangeProposalImpact[],_e:DomainEvent){const old=await this.findByIdempotencyKey(p.organizationId,p.idempotencyKey);if(old)return{value:old,created:false};const v={proposal:p,impacts:i};this.values.set(p.id,v);return{value:v,created:true}}
  async applyWithOutbox(p:ChangeProposal,e:Event,_d:DomainEvent[]){const current=this.values.get(p.id);if(!current||current.proposal.status!=='proposed')return{value:current??{proposal:p,impacts:[]},applied:false};this.values.set(p.id,{proposal:p,impacts:current.impacts});const idx=this.es.events.findIndex(x=>x.id===e.id);if(idx>=0)this.es.events[idx]=e;return{value:this.values.get(p.id)!,applied:true}}
  async rejectWithOutbox(p:ChangeProposal,_e:DomainEvent){const current=this.values.get(p.id);if(!current||current.proposal.status!=='proposed')return{value:current??{proposal:p,impacts:[]},rejected:false};this.values.set(p.id,{proposal:p,impacts:current.impacts});return{value:this.values.get(p.id)!,rejected:true}}
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
    if(user.includes('horário')) return tool('propose_event_time_change',{eventId:ANA,time:'17:00'})
    if(user.includes('Configure o briefing D-1')) return tool('configure_d_minus_1_brief',{enabled:true,localTime:'18:30',recipient:'+5521977776666'})
    if(user.includes('ative o briefing D-1 para 19h')) return tool('configure_d_minus_1_brief',{enabled:'true',localTime:'19:00'})
    if(user.includes('envie para 21996660000')) return tool('configure_d_minus_1_brief',{recipient:'21996660000'})
    if(user.includes('Qual o briefing D-1')||user.includes('Estamos prontos para amanhã')) return tool('get_d_minus_1_brief',{eventId:ANA})
    if(user.includes('Gere o briefing D-1')) return tool('generate_d_minus_1_brief',{eventId:ANA})
    if(user.includes('configure meu brief diario pa 21h50')) return tool('configure_daily_brief',{enabled:false,localTime:'21:00'})
    if(user.includes('ative meu brief diario')) return tool('configure_daily_brief',{enabled:'true'})
    if(user.includes('mude apenas o horario do brief diario')) return tool('configure_daily_brief',{enabled:'true',localTime:'22:10'})
    if(user.includes('desative meu brief diario')) return tool('configure_daily_brief',{enabled:'true'})
    if(user.includes('envie para 21996570056')) return tool('configure_daily_brief',{recipient:'21996570056'})
    if(user.trim()==='21995551234') return tool('configure_daily_brief',{recipient:'21995551234'})
    if(user.includes('Configure o brief')) return tool('configure_daily_brief',{enabled:true,localTime:'07:30',recipient:'+5521999999999'})
    if(user.includes('Qual o brief')) return tool('get_daily_brief',{})
    if(user.includes('Gere o brief')) return tool('generate_daily_brief',{})
    if(user.includes('Recalcule a saúde')) return tool('evaluate_event_health',{eventId:ANA})
    if(user.includes('saúde')) return tool('get_event_health',{eventId:ANA})
    if(user==='NÃO APROVE'){const system=input.messages.find(m=>m.role==='system'&&m.content.includes('PROPOSTAS DE MUDANÇA PENDENTES'))?.content??'';const section=system.split('PROPOSTAS DE MUDANÇA PENDENTES')[1]??'';const proposalId=section.match(/\"id\":\"([0-9a-f-]{36})\"/i)?.[1];if(proposalId)return tool('approve_change_proposal',{proposalId})}
    if(user.trim().toLowerCase()==='sim'){const system=input.messages.find(m=>m.role==='system'&&m.content.includes('PROPOSTAS DE MUDANÇA PENDENTES'))?.content??'';const section=system.split('PROPOSTAS DE MUDANÇA PENDENTES')[1]??'';const proposalId=section.match(/\"id\":\"([0-9a-f-]{36})\"/i)?.[1];if(proposalId)return tool('approve_change_proposal',{proposalId})}
    return tool('get_event_details',{eventId:ANA})
  }
}
function tool(name:string,args:Record<string,unknown>):AgentProviderResponse{const call={name,arguments:args};return{message:{role:'assistant',content:'',toolCalls:[call]},toolCalls:[call]}}

const es=new EStore();const vs=new VStore(es);const cs=new CStore();const as=new AStore();let seq=0
const eventEngine=new EventEngine({store:es,now,newId:()=>`event-generated-${++seq}`})
const vendorEngine=new VendorEngine({store:vs,now,newId:()=>`vendor-generated-${++seq}`})
const commandEngine=new CommandEngine({store:cs,eventEngine,vendorEngine,interpreter:new RuleBasedCommandInterpreter(),now,newId:()=>`command-${++seq}`})
const cpStore=new CPStore(es)
const changeProposalEngine=new ChangeProposalEngine({store:cpStore,eventEngine,vendorEngine,now,newId:()=>`33333333-3333-4333-8333-${String(++seq).padStart(12,'0')}`})
const provider=new ScriptedProvider()
const dependencyEngine={async list(){return[]},async get(){throw new Error('dependency not configured in legacy agent test')},async applySuggestion(){throw new Error('dependency not configured')},async applySuggestionsForProposal(){return{impacts:[],applied:0,duplicates:0,failed:[],reply:'0 ajuste(s) de dependência aplicado(s).'}},async resolveReview(){throw new Error('dependency not configured')}} as any
const riskEngine={async list(){return[]},async workspaceSummary(){return[]},async evaluateEvent(){return{risks:[],detected:0,updated:0,resolved:0,duplicate:false}},async get(){throw new Error('risk not configured')},async acknowledge(){throw new Error('risk not configured')}} as any
const healthEngine={async getCurrent(_o:string,eventId:string){const e=es.events.find(x=>x.id===eventId)!;return{event:e,score:e.healthScore,status:'excellent',breakdown:null,evaluatedAt:null,delta:null}},async workspace(){return[]},async evaluateEvent(){return{evaluation:{score:100,status:'excellent',previousScore:100,delta:0,breakdown:{},evaluatedAt:fixedNow},duplicate:false,changed:false}}} as any
const briefState:any={
  preference:{organizationId:'org-1',enabled:false,localTime:'08:00',channel:'whatsapp',recipient:null,updatedBySender:null,createdAt:fixedNow,updatedAt:fixedNow},
  dMinus1Schedule:{organizationId:'org-1',type:'d_minus_1',enabled:false,localTime:'18:00',channel:'whatsapp',recipient:null,updatedBySender:null,createdAt:fixedNow,updatedAt:fixedNow},
  brief:{id:'brief-1',organizationId:'org-1',type:'daily',eventId:null,referenceDate:'2026-08-17',revision:1,status:'generated',triggerType:'agent',triggerKey:'test',summary:{referenceDate:'2026-08-17',timezone:'America/Sao_Paulo',activeEvents:2,criticalEvents:0,attentionEvents:0,overdueTasks:1,dueTodayTasks:1,pendingVendors:0,openDependencies:0,pendingChanges:0,openInbox:0,events:[],priorities:[{rank:1,type:'task',eventId:ANA,eventName:'Ana & Pedro',sourceId:'task-1',severity:'high',score:80,title:'Confirmar buffet',reason:'Tarefa atrasada'}]},renderedText:'Bom dia! Prioridade: confirmar buffet.',generatedBySender:'planner',generatedAt:fixedNow,supersededAt:null,deliveryRequestedAt:null},
  dMinus1:{id:'brief-d1-1',organizationId:'org-1',type:'d_minus_1',eventId:ANA,referenceDate:'2026-10-16',revision:1,status:'generated',triggerType:'agent',triggerKey:'d1-test',summary:{referenceDate:'2026-10-16',timezone:'America/Sao_Paulo',readiness:'READY_WITH_WARNINGS',readinessReasons:['1 fornecedor ainda precisa de confirmação'],event:{eventId:ANA,eventName:'Ana & Pedro',startAt:'2026-10-17T20:00:00.000Z',endAt:'2026-10-18T02:00:00.000Z',venueName:'Casa A',venueAddress:null,guestCount:120,healthScore:82,healthStatus:'good'},counts:{activeRisks:1,criticalRisks:0,highRisks:1,openTasks:1,overdueTasks:0,criticalOpenTasks:0,openMilestones:0,confirmedVendors:1,pendingVendors:1,declinedVendors:0,openDependencies:0,pendingChanges:0,openInbox:0},risks:[],tasks:[],milestones:[],vendors:[],dependencies:[],changes:[],inbox:[],timeline:[]},renderedText:'Briefing D-1 — Ana & Pedro. Pronto com alertas.',generatedBySender:'planner',generatedAt:fixedNow,supersededAt:null,deliveryRequestedAt:null}
}
const briefEngine={
  async getToday(){return briefState.brief},async list(){return[briefState.brief]},
  async getPreference(){return briefState.preference},
  async configurePreference(input:any){briefState.preference={...briefState.preference,...input,organizationId:'org-1',channel:'whatsapp',createdAt:fixedNow,updatedAt:fixedNow};return briefState.preference},
  async getSchedule(_o:string,type:string){return type==='d_minus_1'?briefState.dMinus1Schedule:{...briefState.preference,type:'daily'}},
  async configureSchedule(input:any){if(input.type==='d_minus_1'){briefState.dMinus1Schedule={...briefState.dMinus1Schedule,...input,organizationId:'org-1',channel:'whatsapp',createdAt:fixedNow,updatedAt:fixedNow};return briefState.dMinus1Schedule}briefState.preference={...briefState.preference,...input,organizationId:'org-1',channel:'whatsapp',createdAt:fixedNow,updatedAt:fixedNow};return{...briefState.preference,type:'daily'}},
  async generateDaily(){return{brief:briefState.brief,duplicate:false}},
  async getDMinus1(){return briefState.dMinus1},
  async generateDMinus1(){return{brief:briefState.dMinus1,duplicate:false}},
  async listDMinus1(){return[briefState.dMinus1]}
} as any
const agent=new OperationalAgent({store:as,provider,eventEngine,vendorEngine,commandEngine,changeProposalEngine,dependencyEngine,riskEngine,healthEngine,briefEngine,operations:{async listActivity(){return[]},async listInbox(){return[]}},now,newId:()=>`agent-${++seq}`,historyTurns:6})
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
  assert(r.turn.toolTrace[0]?.name==='propose_event_time_change','sensitive write creates a proposal')
  assert(es.events[0]!.startAt.toISOString()===before&&es.tasks.length===taskCount,'proposal does not mutate event before approval')
  const pending=[...cpStore.values.values()].find(v=>v.proposal.status==='proposed')
  assert(pending?.proposal.proposedValue.time==='17:00','proposal stores normalized target time')
  let blocked=false
  try{await agent.chat({...base,text:'NÃO APROVE',idempotencyKey:'agent-sensitive-malicious-approve'})}catch(error){blocked=typeof error==='object'&&error!==null&&'code'in error&&(error as {code?:unknown}).code==='OPERATIONAL_AGENT_VALIDATION_ERROR'}
  assert(blocked&&pending?.proposal.status==='proposed','server blocks approval tool when current user text rejects approval')
  const approved=await agent.chat({...base,text:'sim',idempotencyKey:'agent-sensitive-approve'})
  assert(approved.turn.toolTrace[0]?.name==='approve_change_proposal','explicit follow-up approves pending proposal')
  assert(es.events[0]!.startAt.toISOString()!==before,'approved proposal mutates event')
}
{
  await changeProposalEngine.create({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',eventId:ANA,requestedBySender:'planner',idempotencyKey:'ambiguous-guest',type:'guest_count',proposedValue:{guestCount:140}})
  await changeProposalEngine.create({organizationId:'org-1',organizationTimezone:'America/Sao_Paulo',eventId:ANA,requestedBySender:'planner',idempotencyKey:'ambiguous-venue',type:'venue',proposedValue:{venueName:'Casa B'}})
  let ambiguous=false
  try{await agent.chat({...base,text:'sim',idempotencyKey:'agent-ambiguous-approve'})}catch(error){ambiguous=typeof error==='object'&&error!==null&&'code'in error&&(error as {code?:unknown}).code==='OPERATIONAL_AGENT_VALIDATION_ERROR'}
  assert(ambiguous,'generic approval is blocked when more than one proposal is pending')
}
{
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Qual a saúde deste evento?',idempotencyKey:'agent-health-read'})
  assert(r.turn.toolTrace[0]?.name==='get_event_health'&&r.turn.modelCalls===2,'agent reads deterministic Health Score through health tool')
}
{
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Recalcule a saúde deste evento',idempotencyKey:'agent-health-evaluate'})
  assert(r.turn.toolTrace[0]?.name==='evaluate_event_health'&&r.turn.modelCalls===1,'explicit Health Score recalculation uses guarded write tool')
}
{
  const r=await agent.chat({...base,text:'Qual o brief de hoje?',idempotencyKey:'agent-brief-read'})
  assert(r.turn.toolTrace[0]?.name==='get_daily_brief'&&r.turn.modelCalls===2,'agent reads Daily Brief through brief tool')
}
{
  const r=await agent.chat({...base,text:'Configure o brief para todo dia às 07:30 no +55 21 99999-9999',idempotencyKey:'agent-brief-config'})
  assert(r.turn.toolTrace[0]?.name==='configure_daily_brief'&&briefState.preference.enabled&&briefState.preference.localTime==='07:30','agent explicitly configures scheduled Daily Brief')
}
{
  briefState.preference={...briefState.preference,enabled:false,localTime:'08:00',recipient:null}
  const r=await agent.chat({...base,text:'configure meu brief diario pa 21h50 todos os dias',idempotencyKey:'agent-brief-model-false'})
  assert(r.turn.toolTrace[0]?.name==='configure_daily_brief','brief schedule request still uses configure tool')
  assert(!briefState.preference.enabled&&briefState.preference.localTime==='21:50','server overrides erroneous model disable intent and parses 21h50 from user text')
  assert(r.reply.includes('informe o número de WhatsApp'),'missing delivery recipient is handled conversationally instead of HTTP 422')
}
{
  const r=await agent.chat({...base,text:'envie para 21996570056',idempotencyKey:'agent-brief-recipient-continuation'})
  assert(r.turn.toolTrace[0]?.name==='configure_daily_brief','phone-only follow-up continues pending Daily Brief configuration')
  assert(briefState.preference.enabled&&briefState.preference.localTime==='21:50'&&briefState.preference.recipient==='21996570056','pending recipient follow-up completes activation without repeating Daily Brief wording')
}
{
  let blocked=false
  try{await agent.chat({...base,text:'21995551234',idempotencyKey:'agent-brief-random-phone'})}catch(error){blocked=typeof error==='object'&&error!==null&&'code'in error&&(error as {code?:unknown}).code==='OPERATIONAL_AGENT_VALIDATION_ERROR'}
  assert(blocked,'phone-only message is blocked when there is no pending Daily Brief recipient request')
}
{
  briefState.preference={...briefState.preference,enabled:false,localTime:'21:50',recipient:null}
  const r=await agent.chat({...base,text:'ative meu brief diario',idempotencyKey:'agent-brief-string-boolean'})
  assert(!briefState.preference.enabled&&briefState.preference.localTime==='21:50','string boolean from model no longer causes 422 and preserves configured time')
  assert(r.reply.includes('informe o número de WhatsApp'),'activation without recipient asks for WhatsApp number')
}
{
  const r=await agent.chat({...base,text:'ative meu brief diario no WhatsApp +55 21 98888-7777',idempotencyKey:'agent-brief-string-boolean-phone'})
  assert(briefState.preference.enabled&&briefState.preference.localTime==='21:50'&&briefState.preference.recipient==='5521988887777','recipient in current user text completes activation despite malformed model boolean')
}
{
  briefState.preference={...briefState.preference,enabled:false,localTime:'21:50'}
  const r=await agent.chat({...base,text:'mude apenas o horario do brief diario para 22h10',idempotencyKey:'agent-brief-time-only'})
  assert(!briefState.preference.enabled&&briefState.preference.localTime==='22:10','time-only change preserves disabled state even when model incorrectly sends enabled=true')
}
{
  briefState.preference={...briefState.preference,enabled:true,recipient:'5521988887777'}
  const r=await agent.chat({...base,text:'desative meu brief diario',idempotencyKey:'agent-brief-disable-authoritative-text'})
  assert(!briefState.preference.enabled,'explicit user disable wins even when model incorrectly sends enabled=true')
}
{
  const r=await agent.chat({...base,text:'Gere o brief de hoje',idempotencyKey:'agent-brief-generate'})
  assert(r.turn.toolTrace[0]?.name==='generate_daily_brief'&&r.turn.modelCalls===1,'agent explicitly generates Daily Brief without second model call')
}
{
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Qual o briefing D-1 deste evento?',idempotencyKey:'agent-d1-read'})
  assert(r.turn.toolTrace[0]?.name==='get_d_minus_1_brief'&&r.turn.modelCalls===2,'agent reads deterministic D-1 briefing through event-scoped tool')
}
{
  const dailyBefore={...briefState.preference}
  const r=await agent.chat({...base,text:'Configure o briefing D-1 para 18h30 no +55 21 97777-6666',idempotencyKey:'agent-d1-config'})
  assert(r.turn.toolTrace[0]?.name==='configure_d_minus_1_brief'&&briefState.dMinus1Schedule.enabled&&briefState.dMinus1Schedule.localTime==='18:30','agent explicitly configures independent D-1 schedule')
  assert(briefState.preference.enabled===dailyBefore.enabled&&briefState.preference.localTime===dailyBefore.localTime&&briefState.preference.recipient===dailyBefore.recipient,'D-1 configuration never mutates Daily Brief schedule')
}
{
  briefState.dMinus1Schedule={...briefState.dMinus1Schedule,enabled:false,localTime:'18:00',recipient:null}
  const r=await agent.chat({...base,text:'ative o briefing D-1 para 19h',idempotencyKey:'agent-d1-needs-recipient'})
  assert(r.turn.toolTrace[0]?.name==='configure_d_minus_1_brief'&&!briefState.dMinus1Schedule.enabled&&briefState.dMinus1Schedule.localTime==='19:00','D-1 activation without recipient saves time without enabling delivery')
  assert(r.reply.includes('informe o número de WhatsApp'),'D-1 activation asks for missing WhatsApp recipient')
}
{
  const r=await agent.chat({...base,text:'envie para 21996660000',idempotencyKey:'agent-d1-recipient-continuation'})
  assert(r.turn.toolTrace[0]?.name==='configure_d_minus_1_brief','phone-only follow-up continues pending D-1 recipient configuration')
  assert(briefState.dMinus1Schedule.enabled&&briefState.dMinus1Schedule.localTime==='19:00'&&briefState.dMinus1Schedule.recipient==='21996660000','D-1 pending recipient continuation completes activation')
}
{
  const r=await agent.chat({...base,explicitEventId:ANA,text:'Gere o briefing D-1 deste evento',idempotencyKey:'agent-d1-generate'})
  assert(r.turn.toolTrace[0]?.name==='generate_d_minus_1_brief'&&r.turn.modelCalls===1,'explicit D-1 generation uses deterministic reply without second model call')
}
{
  const {turn}=await as.createTurnIfAbsent({id:'stuck-turn',organizationId:'org-1',sender:'planner',idempotencyKey:'stuck-key',userText:'Como estão meus eventos?',provider:'ollama',model:'fake',now:fixedNow})
  await as.updateTurn('org-1',turn.id,{status:'processing',updatedAt:fixedNow})
  let conflict=false
  try{await agent.chat({...base,text:'Como estão meus eventos?',idempotencyKey:'stuck-key'})}catch(error){conflict=typeof error==='object'&&error!==null&&'code'in error&&(error as {code?:unknown}).code==='OPERATIONAL_AGENT_TURN_CONFLICT'}
  assert(conflict,'incomplete turn is never automatically replayed')
}

console.log('OperationalAgent: 26/26 behavioral scenarios passed')
