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
if version!='0.12.0': fail(f'version expected 0.12.0, got {version}')
for n in ['016_risk_engine','migration016RiskEngine']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('risk_evaluations')","createTable('event_risks')",'risk_evaluations_trigger_unique','event_risks_key_unique','event_risks_score_check']:
  if n not in text('packages/database/src/migrations/016_risk_engine.ts'): fail(f'migration 016 missing {n}')
for n in ['RiskEngine','evaluateEvent','evaluateDomainEvent','evaluateScheduled','workspaceSummary','acknowledge','task_overdue','vendor_unconfirmed','change_dependency_pending']:
  if n not in text('packages/event-engine/src/risk-engine.ts'): fail(f'risk engine missing {n}')
for n in ['pg_advisory_xact_lock','reconcileEvaluation','risk.detected','risk.updated','risk.resolved','risk.evaluation_completed']:
  if n not in text('packages/database/src/repositories/kysely-risk-store.ts'): fail(f'risk store missing {n}')
for n in ['/api/v1/risks','/api/v1/risks/workspace','/api/v1/events/:eventId/risks/evaluate','/api/v1/risks/:id/acknowledge']:
  if n not in text('apps/api/src/routes/risks.ts'): fail(f'risk API missing {n}')
for n in ['get_event_risks','get_workspace_risks','evaluate_event_risks','acknowledge_risk','Riscos são calculados deterministicamente']:
  if n not in text('packages/event-engine/src/operational-agent.ts'): fail(f'agent risk integration missing {n}')
for n in ['riskEngine.evaluateDomainEvent','evaluateScheduled','RISK_SWEEP_INTERVAL_MS']:
  if n not in text('apps/worker/src/index.ts') and n not in text('compose.yaml'): fail(f'worker risk hook missing {n}')
for n in ['risk.detected','risk.updated','risk.acknowledged','risk.resolved']:
  if n not in text('packages/event-engine/src/operational-projector.ts'): fail(f'projector missing {n}')
for n in ['53/62 create overdue critical task','56/62 query event risks through Operational Agent','59/62 verify risk and inbox auto-resolved','62/62 verify all generated domain events']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
if 'RISK_SWEEP_INTERVAL_MS=0' not in text('.env.smoke'): fail('smoke must disable periodic risk sweep')
for doc in ['docs/mini-feature-12.md','docs/mini-feature-11.md','docs/mini-feature-10.md','docs/openrouter-operational-agent.md']:
  text(doc)
readme=text('README.md')
for n in ['0.12.0 — Risk Engine','⚠️ Risk Engine','docs/mini-feature-12.md','🧪 Validação','13 Health Score            próxima']:
  if n not in readme: fail(f'README missing {n}')
if '| 12 — Risk Engine | [mini-feature-12.md](mini-feature-12.md) |' not in text('docs/README.md'): fail('docs index missing feature 12')
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
print('\nMini-feature 12 Risk Engine validation passed.')
