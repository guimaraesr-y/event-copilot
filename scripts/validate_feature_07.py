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
if json.loads(text('package.json')).get('version')!='0.7.0': fail('version')
for n in ['009_operational_inbox_activity','migration009OperationalInboxActivity']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('activity_entries')","createTable('inbox_items')",'activity_entries_source_event_unique','inbox_items_source_type_unique']:
  if n not in text('packages/database/src/migrations/009_operational_inbox_activity.ts'): fail(f'migration missing {n}')
for n in ['OperationalProjector','vendor.confirmed','message.review_required','message.failed']:
  if n not in text('packages/event-engine/src/operational-projector.ts'): fail(f'projector missing {n}')
for n in ['OperationalRepository','applyProjection','listActivity','listInbox','resolveInboxItem','dismissInboxItem']:
  if n not in text('packages/database/src/repositories/operational-repository.ts'): fail(f'operations repo missing {n}')
worker=text('apps/worker/src/index.ts')
for n in ['OperationalProjector','applyProjection','await dispatch(message)']:
  if n not in worker: fail(f'worker projection missing {n}')
route=text('apps/api/src/routes/operations.ts')
for n in ['/api/v1/events/:eventId/activity','/api/v1/inbox','/resolve','/dismiss']:
  if n not in route: fail(f'route missing {n}')
for n in ['message.review_required','candidateEventVendorIds']:
  if n not in text('packages/event-engine/src/messaging-engine.ts'): fail(f'ambiguous review missing {n}')
for n in ['verify event activity timeline','verify operational inbox item','resolve inbox item']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
for cfg in ['validation/tsconfig.full.json','validation/tsconfig.core.json','validation/tsconfig.messaging.json']:
  r=subprocess.run(['tsc','--noEmit','-p',str(ROOT/cfg)],cwd=ROOT,text=True,capture_output=True)
  if r.returncode: print(r.stdout,r.stderr); fail(cfg)
ok('TypeScript structural/core/messaging compilation')
r=subprocess.run(['sh','-n',str(ROOT/'scripts/smoke.sh'),str(ROOT/'scripts/n8n-sync.sh'),str(ROOT/'scripts/smoke-env.sh')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stderr); fail('shell syntax')
ok('Shell scripts parse')
shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('core emit')
alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
scenario_count=0
for f in sorted((ROOT/'.validation-dist/validation/core-tests').glob('*.test.js')):
  x=subprocess.run(['node',str(f)],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
  if x.returncode: print(x.stderr); fail(f.name)
  scenario_count += 1
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
if x.returncode: print(x.stderr); fail('adapter tests')
ok('Behavioral scenarios pass')
print('\nMini-feature 07 validation passed.')
