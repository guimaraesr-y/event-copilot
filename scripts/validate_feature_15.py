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
if version!='0.15.0': fail(f'version expected 0.15.0, got {version}')
for n in ['019_d_minus_1_brief','migration019DMinus1Brief']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
migration=text('packages/database/src/migrations/019_d_minus_1_brief.ts')
for n in ["createTable('organization_brief_schedules')",'organization_brief_schedules_type_check','organization_brief_schedules_enabled_recipient_check',"addColumn('event_id'",'daily_briefs_daily_revision_unique','daily_briefs_event_revision_unique','daily_briefs_event_scope_check']:
  if n not in migration: fail(f'migration 019 missing {n}')
brief=text('packages/event-engine/src/brief-engine.ts')
for n in ['generateDMinus1','getDMinus1','listDMinus1','buildDMinus1Summary','renderDMinus1Brief','READY_WITH_WARNINGS','NOT_READY','scheduled:d_minus_1','processDueSchedules']:
  if n not in brief: fail(f'D-1 Brief Engine missing {n}')
store=text('packages/database/src/repositories/kysely-brief-store.ts')
for n in ['organization_brief_schedules','loadDMinus1Snapshot','persistDMinus1','getLatestDMinus1','listDMinus1','getSchedule','updateSchedule']:
  if n not in store: fail(f'D-1 persistence missing {n}')
routes=text('apps/api/src/routes/briefs.ts')
for n in ['/api/v1/briefs/schedules/:type','/api/v1/events/:eventId/briefs/d-minus-1','/api/v1/events/:eventId/briefs/d-minus-1/generate','/api/v1/events/:eventId/briefs/d-minus-1/history']:
  if n not in routes: fail(f'D-1 API missing {n}')
agent=text('packages/event-engine/src/operational-agent.ts')
for n in ['get_d_minus_1_brief','generate_d_minus_1_brief','get_d_minus_1_settings','configure_d_minus_1_brief','Briefing D-1 é específico por evento','needsRecipient']:
  if n not in agent: fail(f'agent D-1 integration missing {n}')
provider=text('packages/event-engine/src/operational-agent-provider.ts')
for n in ['configure_d_minus_1_brief','generate_d_minus_1_brief','get_d_minus_1_brief']:
  if n not in provider: fail(f'deterministic provider D-1 routing missing {n}')
messaging=text('packages/event-engine/src/messaging-engine.ts')
for n in ["const BRIEF_ACTION = 'brief.prepare'",'d_minus_1_brief','prepareBrief(actionId']:
  if n not in messaging: fail(f'generic brief messaging missing {n}')
for n in ['/api/v1/internal/automations/brief-delivery-requested','brief.prepare']:
  if n not in text('apps/api/src/routes/domain-events.ts'): fail(f'generic brief automation missing {n}')
if '/brief-message' not in text('apps/api/src/routes/messaging.ts'): fail('generic brief message API missing')
workflow=text('n8n/workflows/ecc-domain-event-gateway.json')
for n in ['Is Brief Delivery Requested?','Prepare Brief','Create Brief Message','Send Brief Message','brief.delivery_requested']:
  if n not in workflow: fail(f'n8n generic brief workflow missing {n}')
smoke=text('scripts/smoke.sh')
for n in ['70/82 create D-1 smoke event for tomorrow','71/82 configure D-1 schedule independently through Operational Agent','72/82 wait for scheduled D-1 briefing and WhatsApp delivery','75/82 query D-1 readiness through Operational Agent','77/82 verify manual D-1 revision, idempotency and history','82/82 verify all generated domain events']:
  if n not in smoke: fail(f'smoke missing {n}')
if 'd_minus_1_brief' not in smoke or 'D1_START_AT' not in smoke: fail('smoke does not exercise scheduled D-1 delivery')
if "AND type='d_minus_1' AND event_id=" in smoke: fail("smoke queries daily_briefs.type, but the schema column is brief_type")
if smoke.count("AND brief_type='d_minus_1' AND event_id=") < 2: fail("smoke must query D-1 rows through daily_briefs.brief_type")
if 'BRIEF_SCHEDULER_INTERVAL_MS=500' not in text('.env.smoke'): fail('smoke brief scheduler interval missing')
compose=text('compose.yaml')
for n in ['n8n-init:','service_completed_successfully','n8n publish:workflow --id=eccDomainEventGw1']:
  if n not in compose: fail(f'n8n auto-bootstrap missing {n}')
compose_override=text('compose.override.yaml')
for n in ['n8n-init:','/bin/sh','-lc','n8n import:workflow --input=/files/n8n/workflows/ecc-domain-event-gateway.json','n8n publish:workflow --id=eccDomainEventGw1','command: []','N8N_WEBHOOK_URL:']:
  if n not in compose_override: fail(f'n8n one-shot override missing {n}')
if 'N8N_RUNNERS_ENABLED' in compose_override: fail('N8N_RUNNERS_ENABLED is deprecated in n8n 2.x and must not be set in the override')
for doc in ['docs/mini-feature-15.md','docs/mini-feature-14.md','docs/README.md']:
  text(doc)
readme=text('README.md')
for n in ['0.15.0 — Briefing D-1','🌙 Briefing D-1','docs/mini-feature-15.md','15 Briefing D-1            ✅','16 Event Day Mode           próxima']:
  if n not in readme: fail(f'README missing {n}')
if '| 15 — Briefing D-1 | [mini-feature-15.md](mini-feature-15.md) |' not in text('docs/README.md'): fail('docs index missing feature 15')
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
try: json.loads(workflow)
except Exception as e: fail(f'invalid n8n workflow JSON: {e}')
ok('n8n workflow JSON parses')

shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('core emit')
alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
core_count=0
for f in sorted((ROOT/'.validation-dist/validation/core-tests').glob('*.test.js')):
  x=subprocess.run(['node',str(f)],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
  if x.returncode: print(x.stderr); fail(f.name)
  core_count+=1
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
if x.returncode: print(x.stderr); fail('adapter tests')
ok(f'Behavioral suites pass ({core_count} core files + messaging adapters)')
print('\nMini-feature 15 Briefing D-1 validation passed.')
