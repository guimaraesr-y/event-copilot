import {
  AICommandInterpreter,
  OllamaCommandProvider,
  OpenAICommandProvider,
  RuleBasedCommandInterpreter,
} from '../../packages/event-engine/src/index.ts'

function assert(ok: unknown, msg: string): asserts ok { if (!ok) throw new Error(`Assertion failed: ${msg}`) }
const events=[{id:'event-1',name:'Ana & Pedro',type:'wedding' as const,startAt:new Date('2026-10-17T20:30:00Z')}]
const input={text:'Crie uma tarefa no casamento da Ana para confirmar o buffet amanhã às 10h.',now:new Date('2026-08-15T03:00:00Z'),timezone:'America/Sao_Paulo',currentEventName:null,availableEvents:events}

{
  const interpreter=new RuleBasedCommandInterpreter()
  const result=await interpreter.interpret(input)
  assert(result.intent==='CREATE_TASK','rule-based classifies create task')
  assert(result.eventReference==='Ana & Pedro','rule-based resolves named event from token')
  assert(result.taskTitle==='confirmar o buffet','task title extracted')
  assert(result.dueAt==='2026-08-16T13:00:00.000Z','tomorrow 10:00 resolves in organization timezone')
}
{
  const interpreter=new RuleBasedCommandInterpreter()
  const result=await interpreter.interpret({...input,text:'Mude o horário do casamento da Ana para 17h'})
  assert(result.intent==='SENSITIVE_CHANGE' && result.sensitiveField==='event_time','sensitive mutation is gated')
}
{
  let captured:any=null
  const structured={intent:'GET_EVENT_STATUS',confidence:0.98,eventReference:'Ana & Pedro',taskReference:null,taskTitle:null,dueAt:null,note:null,sensitiveField:null,sensitiveValue:null,rationale:null}
  const fakeFetch:typeof fetch=async (_url:any,init:any)=>{
    captured=JSON.parse(String(init?.body))
    return new Response(JSON.stringify({message:{role:'assistant',content:JSON.stringify(structured)},done:true}),{status:200,headers:{'content-type':'application/json'}})
  }
  const provider=new OllamaCommandProvider({model:'qwen-test',fetchImpl:fakeFetch})
  const result=await new AICommandInterpreter(provider).interpret({...input,text:'Como está o casamento da Ana?'})
  assert(result.intent==='GET_EVENT_STATUS','Ollama AI interpreter parses structured result')
  assert(captured.model==='qwen-test' && captured.stream===false && captured.think===false,'Ollama request is non-streaming and disables thinking')
  assert(captured.format?.additionalProperties===false,'Ollama receives the strict command JSON schema')
  assert(captured.options?.temperature===0,'Ollama uses deterministic temperature')
}
{
  let captured:any=null
  const structured={intent:'GET_EVENT_STATUS',confidence:0.98,eventReference:'Ana & Pedro',taskReference:null,taskTitle:null,dueAt:null,note:null,sensitiveField:null,sensitiveValue:null,rationale:null}
  const fakeFetch:typeof fetch=async (_url:any,init:any)=>{
    captured=JSON.parse(String(init?.body))
    return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(structured)}]}]}),{status:200,headers:{'content-type':'application/json'}})
  }
  const provider=new OpenAICommandProvider({apiKey:'test-key',model:'gpt-test',fetchImpl:fakeFetch})
  const result=await new AICommandInterpreter(provider).interpret({...input,text:'Como está o casamento da Ana?'})
  assert(result.intent==='GET_EVENT_STATUS','OpenAI AI interpreter parses structured result')
  assert(captured.model==='gpt-test' && captured.store===false,'OpenAI request uses configured Responses model without storage')
  assert(captured.text?.format?.type==='json_schema' && captured.text?.format?.strict===true,'OpenAI uses strict Structured Outputs')
}
{
  const fakeFetch:typeof fetch=async()=>new Response(JSON.stringify({message:{role:'assistant',content:'not-json'},done:true}),{status:200})
  const provider=new OllamaCommandProvider({fetchImpl:fakeFetch})
  let failed=false
  try{await new AICommandInterpreter(provider).interpret(input)}catch{failed=true}
  assert(failed,'AI interpreter rejects invalid provider structured output')
}

console.log('CommandInterpreter: 5/5 behavioral scenarios passed')
