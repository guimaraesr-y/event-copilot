import { AICommandInterpreter, OllamaCommandProvider } from '../../packages/event-engine/src/index.ts'

const model=process.env.OLLAMA_COMMAND_MODEL?.trim() || 'qwen3:4b'
const baseUrl=process.env.OLLAMA_BASE_URL?.trim() || 'http://127.0.0.1:11434'
const timeoutMs=Number.parseInt(process.env.OLLAMA_COMMAND_TIMEOUT_MS || '120000',10)
const provider=new OllamaCommandProvider({model,baseUrl,timeoutMs,keepAlive:process.env.OLLAMA_KEEP_ALIVE || '10m'})
const interpreter=new AICommandInterpreter(provider)
const events=[
  {id:'event-1',name:'Ana & Pedro',type:'wedding' as const,startAt:new Date('2026-10-17T20:30:00Z')},
  {id:'event-2',name:'Laura 15 anos',type:'birthday' as const,startAt:new Date('2026-10-24T20:00:00Z')},
]
const now=new Date('2026-08-15T03:00:00Z')
const cases=[
  {text:'Como está o casamento da Ana?',intent:'GET_EVENT_STATUS'},
  {text:'Quais fornecedores ainda não confirmaram no casamento da Ana?',intent:'GET_PENDING_VENDORS'},
  {text:'Crie uma tarefa no casamento da Ana para confirmar o buffet amanhã às 10h.',intent:'CREATE_TASK',taskTitle:'confirmar o buffet'},
  {text:'Adicione uma observação no casamento da Ana dizendo que a avó da noiva precisa de acesso facilitado.',intent:'ADD_EVENT_NOTE'},
  {text:'Mude o horário do casamento da Ana para 17h.',intent:'SENSITIVE_CHANGE'},
] as const

let passed=0
let totalMs=0
console.log(`Ollama command check — model=${model} baseUrl=${baseUrl}`)
for (const c of cases) {
  const started=performance.now()
  try {
    const out=await interpreter.interpret({text:c.text,now,timezone:'America/Sao_Paulo',currentEventName:null,availableEvents:events})
    const ms=Math.round(performance.now()-started); totalMs+=ms
    const ok=out.intent===c.intent && (!('taskTitle' in c) || out.taskTitle===c.taskTitle)
    if(ok) passed++
    console.log(`${ok?'PASS':'FAIL'} ${ms}ms | ${c.text}`)
    console.log(`     intent=${out.intent} event=${out.eventReference ?? '-'} task=${out.taskTitle ?? '-'}`)
  } catch (error) {
    const ms=Math.round(performance.now()-started); totalMs+=ms
    console.log(`ERROR ${ms}ms | ${c.text}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`\nResult: ${passed}/${cases.length} correct · avg ${Math.round(totalMs/cases.length)}ms`)
if(passed!==cases.length) process.exit(1)
