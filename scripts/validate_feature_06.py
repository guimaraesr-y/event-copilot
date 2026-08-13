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
if json.loads(text('package.json')).get('version')!='0.6.0': fail('version')
for n in ['008_supplier_inbound','migration008SupplierInbound']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('inbound_messages')",'resolved_event_vendor_id','candidate_event_vendor_ids','inbound_messages_provider_external_unique']:
  if n not in text('packages/database/src/migrations/008_supplier_inbound.ts'): fail(f'migration missing {n}')
for n in ['findInboundCandidates','createInboundMessageWithOutbox',"eventType: 'message.received'",'needs_review']:
  if n not in text('packages/event-engine/src/messaging-engine.ts'): fail(f'messaging ingress missing {n}')
for n in ['RuleBasedSupplierResponseInterpreter','scheduleRelativeToEvent','vendorEngine.confirm','vendorEngine.decline']:
  if n not in text('packages/event-engine/src/inbound-engine.ts')+text('packages/event-engine/src/supplier-response-interpreter.ts'): fail(f'inbound engine missing {n}')
wf=json.loads(text('n8n/workflows/ecc-domain-event-gateway.json')); names={x['name'] for x in wf['nodes']}
for n in ['Is Supplier Inbound Message?','Process Supplier Response']:
  if n not in names: fail(f'n8n missing {n}')
for n in ['simulate supplier inbound confirmation','verify inbound webhook/process idempotency','inbound_messages']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
for cfg in ['validation/tsconfig.full.json','validation/tsconfig.core.json','validation/tsconfig.messaging.json']:
  r=subprocess.run(['tsc','--noEmit','-p',str(ROOT/cfg)],cwd=ROOT,text=True,capture_output=True)
  if r.returncode: print(r.stdout,r.stderr); fail(cfg)
ok('TypeScript structural/core/messaging compilation')
r=subprocess.run(['sh','-n',str(ROOT/'scripts/smoke.sh'),str(ROOT/'scripts/n8n-sync.sh')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stderr); fail('shell syntax')
ok('Shell scripts parse')
shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('core emit')
alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
for f in sorted((ROOT/'.validation-dist/validation/core-tests').glob('*.test.js')):
  x=subprocess.run(['node',str(f)],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip());
  if x.returncode: print(x.stderr); fail(f.name)
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip());
if x.returncode: print(x.stderr); fail('adapter tests')
ok('Behavioral scenarios pass')
print('\nMini-feature 06 validation passed.')
