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
if json.loads(text('package.json')).get('version')!='0.8.1': fail('version')
for n in ['010_command_engine','migration010CommandEngine']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('command_requests')","createTable('conversation_contexts')","createTable('event_notes')",'event_tasks_command_request_unique']:
  if n not in text('packages/database/src/migrations/010_command_engine.ts'): fail(f'migration missing {n}')
for n in ['RuleBasedCommandInterpreter','AICommandInterpreter','SENSITIVE_CHANGE']:
  if n not in text('packages/event-engine/src/command-interpreter.ts'): fail(f'interpreter missing {n}')
for n in ['AICommandProvider','OllamaCommandProvider','OpenAICommandProvider','/api/chat','json_schema']:
  if n not in text('packages/event-engine/src/ai-command-provider.ts'): fail(f'AI provider missing {n}')
for n in ['CommandEngine','CREATE_TASK','COMPLETE_TASK','ADD_EVENT_NOTE','requiresChangeProposal']:
  if n not in text('packages/event-engine/src/command-engine.ts'): fail(f'command engine missing {n}')
for n in ['/api/v1/commands','/api/v1/command-context']:
  if n not in text('apps/api/src/routes/commands.ts'): fail(f'route missing {n}')
for n in ['COMMAND_INTERPRETER=rule_based','AI_PROVIDER=ollama','OPENAI_API_KEY=']:
  if n not in text('.env.smoke'): fail(f'smoke env missing {n}')
for n in ['select planner event context','create task from conversational context','reject sensitive change','verify command idempotency']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
for cfg in ['validation/tsconfig.full.json','validation/tsconfig.core.json','validation/tsconfig.messaging.json']:
  r=subprocess.run(['tsc','--noEmit','-p',str(ROOT/cfg)],cwd=ROOT,text=True,capture_output=True)
  if r.returncode: print(r.stdout,r.stderr); fail(cfg)
ok('TypeScript structural/core/messaging compilation')
r=subprocess.run(['sh','-n',str(ROOT/'scripts/smoke.sh'),str(ROOT/'scripts/n8n-sync.sh'),str(ROOT/'scripts/smoke-env.sh'),str(ROOT/'scripts/ollama-setup.sh'),str(ROOT/'scripts/ollama-command-check.sh')],cwd=ROOT,text=True,capture_output=True)
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
print('\nMini-feature 08.1 provider-agnostic AI validation passed.')
