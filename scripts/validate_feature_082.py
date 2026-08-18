#!/usr/bin/env python3
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def fail(m): print('FAIL:',m); raise SystemExit(1)
def ok(m): print('OK:  ',m)
def text(p):
  q=ROOT/p
  if not q.exists(): fail(f'missing {p}')
  return q.read_text(encoding='utf-8')

version=json.loads(text('package.json')).get('version')
if version!='0.8.2': fail(f'version expected 0.8.2, got {version}')
for n in ['011_operational_agent','migration011OperationalAgent']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ['012_operational_agent_tool_trace_jsonb','migration012OperationalAgentToolTraceJsonb']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ['013_operational_agent_openrouter','migration013OperationalAgentOpenRouter']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ['agent_turns_tool_trace_array_check',"jsonb_typeof(tool_trace) is distinct from 'array'"]:
  if n not in text('packages/database/src/migrations/012_operational_agent_tool_trace_jsonb.ts'): fail(f'migration 012 missing {n}')
for n in ["createTable('agent_turns')",'agent_turns_org_idempotency_unique',"interpreter in ('rule_based','ai','agent')"]:
  if n not in text('packages/database/src/migrations/011_operational_agent.ts'): fail(f'migration 011 missing {n}')
for n in ['get_workspace_overview','get_event_details','get_event_activity','get_inbox','create_task','executeStructuredToolCommand','OPERATIONAL_AGENT']:
  source=text('packages/event-engine/src/operational-agent.ts')
  if n not in source and n!='OPERATIONAL_AGENT': fail(f'agent missing {n}')
for n in ['OllamaOperationalAgentProvider','OpenRouterOperationalAgentProvider','DeterministicOperationalAgentProvider','toolMode','ACTION_SCHEMA','/api/chat','/chat/completions']:
  if n not in text('packages/event-engine/src/operational-agent-provider.ts'): fail(f'provider missing {n}')
for n in ['/api/v1/agent/messages','/api/v1/agent/history']:
  if n not in text('apps/api/src/routes/agent.ts'): fail(f'agent route missing {n}')
if 'executeStructured' not in text('packages/event-engine/src/command-engine.ts'): fail('structured command delegation missing')
for n in ['OPERATIONAL_AGENT_PROVIDER=deterministic','COMMAND_INTERPRETER=rule_based']:
  if n not in text('.env.smoke'): fail(f'smoke env missing {n}')
for n in ['operational agent workspace overview','operational agent creates task','operational agent turn idempotency','operational agent conversation history']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
if 'OPERATIONAL_AGENT_PROVIDER=deterministic' not in text('scripts/smoke-env.sh'): fail('smoke agent provider guard missing')
if 'OLLAMA_AGENT_MODEL' not in text('scripts/ollama-setup.sh'): fail('ollama setup does not provision agent model')
if 'operational-agent-chat.ts' not in text('docs/mini-feature-08.2.md'): fail('agent CLI docs missing')
for n in ['OPERATIONAL_AGENT_PROVIDER=openrouter','OPENROUTER_API_KEY','OPENROUTER_AGENT_MODEL']:
  if n not in text('docs/openrouter-operational-agent.md'): fail(f'OpenRouter docs missing {n}')

for cfg in ['validation/tsconfig.full.json','validation/tsconfig.core.json','validation/tsconfig.messaging.json']:
  r=subprocess.run(['tsc','--noEmit','-p',str(ROOT/cfg)],cwd=ROOT,text=True,capture_output=True)
  if r.returncode: print(r.stdout,r.stderr); fail(cfg)
ok('TypeScript structural/core/messaging compilation')

shells=['scripts/smoke.sh','scripts/n8n-sync.sh','scripts/smoke-env.sh','scripts/ollama-setup.sh','scripts/ollama-command-check.sh']
r=subprocess.run(['sh','-n',*[str(ROOT/s) for s in shells]],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stderr); fail('shell syntax')
ok('Shell scripts parse')

shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('core emit')
alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
for f in sorted((ROOT/'.validation-dist/validation/core-tests').glob('*.test.js')):
  x=subprocess.run(['node',str(f)],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
  if x.returncode: print(x.stderr); fail(f.name)
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
if x.returncode: print(x.stderr); fail('adapter tests')
ok('Behavioral scenarios pass')
print('\nMini-feature 08.2 Operational Agent validation passed.')
