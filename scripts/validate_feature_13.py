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
if version!='0.13.0': fail(f'version expected 0.13.0, got {version}')
for n in ['017_health_score','migration017HealthScore']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('event_health_evaluations')",'event_health_evaluations_trigger_unique','event_health_score_check','event_health_breakdown_object_check']:
  if n not in text('packages/database/src/migrations/017_health_score.ts'): fail(f'migration 017 missing {n}')
for n in ['HealthEngine','evaluateEvent','evaluateDomainEvent','getCurrent','workspace','history','severityCeiling','categoryPenalties']:
  if n not in text('packages/event-engine/src/health-engine.ts'): fail(f'health engine missing {n}')
for n in ['pg_advisory_xact_lock','reconcileEvaluation','event_health_evaluations','health_score','insertOutbox']:
  if n not in text('packages/database/src/repositories/kysely-health-store.ts'): fail(f'health store missing {n}')
if "eventType: 'health.updated'" not in text('packages/event-engine/src/health-engine.ts'): fail('health engine missing health.updated event')
for n in ['/api/v1/health-scores/workspace','/api/v1/events/:eventId/health-score','/api/v1/events/:eventId/health-score/history','/api/v1/events/:eventId/health-score/evaluate']:
  if n not in text('apps/api/src/routes/health-scores.ts'): fail(f'health API missing {n}')
for n in ['get_event_health','get_workspace_health','evaluate_event_health','Health Score é calculado deterministicamente']:
  if n not in text('packages/event-engine/src/operational-agent.ts'): fail(f'agent health integration missing {n}')
for n in ['KyselyHealthStore','HealthEngine','healthEngine.evaluateDomainEvent']:
  if n not in text('apps/worker/src/index.ts'): fail(f'worker health hook missing {n}')
if "case 'health.updated'" not in text('packages/event-engine/src/operational-projector.ts'): fail('projector missing health.updated')
for n in ['57/68 wait for Health Score degradation','58/68 query Health Score through Operational Agent','63/68 verify Health Score history and activity','68/68 verify all generated domain events']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
for doc in ['docs/mini-feature-13.md','docs/mini-feature-12.md','docs/mini-feature-11.md','docs/mini-feature-10.md']:
  text(doc)
readme=text('README.md')
for n in ['0.13.0 — Health Score','💚 Health Score','docs/mini-feature-13.md','13 Health Score            ✅','14 Daily Command Brief     próxima']:
  if n not in readme: fail(f'README missing {n}')
if '| 13 — Health Score | [mini-feature-13.md](mini-feature-13.md) |' not in text('docs/README.md'): fail('docs index missing feature 13')
for stale in ['OPENROUTER_AGENT_PATCH.md','PATCH.md','VALIDATION.txt']:
  if (ROOT/stale).exists(): fail(f'stale feature documentation remains at repository root: {stale}')

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
core_count=0
for f in sorted((ROOT/'.validation-dist/validation/core-tests').glob('*.test.js')):
  x=subprocess.run(['node',str(f)],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
  if x.returncode: print(x.stderr); fail(f.name)
  core_count += 1
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
if x.returncode: print(x.stderr); fail('adapter tests')
ok(f'Behavioral suites pass ({core_count} core files + messaging adapters)')
print('\nMini-feature 13 Health Score validation passed.')
