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
if version!='0.14.0': fail(f'version expected 0.14.0, got {version}')
for n in ['018_daily_brief','migration018DailyBrief']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('organization_brief_preferences')","createTable('daily_briefs')",'organization_brief_preferences_enabled_recipient_check','daily_briefs_trigger_unique','daily_briefs_revision_unique','daily_briefs_summary_object_check']:
  if n not in text('packages/database/src/migrations/018_daily_brief.ts'): fail(f'migration 018 missing {n}')
for n in ['BriefEngine','generateDaily','processDueSchedules','scheduled:${referenceDate}','buildSummary','renderDailyBrief','priorityScore']:
  if n not in text('packages/event-engine/src/brief-engine.ts'): fail(f'Brief Engine missing {n}')
for n in ['pg_advisory_xact_lock','persistDaily','loadDailySnapshot','brief.delivery_requested','daily_briefs','organization_brief_preferences']:
  if n not in text('packages/database/src/repositories/kysely-brief-store.ts')+text('packages/event-engine/src/brief-engine.ts'): fail(f'brief persistence missing {n}')
for n in ['/api/v1/briefs/settings','/api/v1/briefs/today','/api/v1/briefs/generate','/api/v1/briefs/:briefId']:
  if n not in text('apps/api/src/routes/briefs.ts'): fail(f'brief API missing {n}')
agent=text('packages/event-engine/src/operational-agent.ts')
for n in ['get_daily_brief','generate_daily_brief','get_brief_history','get_daily_brief_settings','configure_daily_brief','Daily Brief é gerado deterministicamente']:
  if n not in agent: fail(f'agent brief integration missing {n}')
provider=text('packages/event-engine/src/operational-agent-provider.ts')
for n in ['configure_daily_brief','generate_daily_brief','get_daily_brief']:
  if n not in provider: fail(f'deterministic provider missing {n}')
worker=text('apps/worker/src/index.ts')
for n in ['KyselyBriefStore','BriefEngine','BRIEF_SCHEDULER_INTERVAL_MS','processDueSchedules']:
  if n not in worker: fail(f'worker brief scheduler missing {n}')
for n in ['brief.delivery_requested','daily_brief.prepare','daily-brief-delivery-requested']:
  if n not in text('apps/api/src/routes/domain-events.ts')+text('packages/event-engine/src/messaging-engine.ts'): fail(f'daily brief delivery integration missing {n}')
workflow=text('n8n/workflows/ecc-domain-event-gateway.json')
for n in ['Is Daily Brief Delivery Requested?','Prepare Daily Brief','Create Daily Brief Message','Send Daily Brief Message','brief.delivery_requested']:
  if n not in workflow: fail(f'n8n workflow missing {n}')
for n in ['64/74 configure scheduled Daily Brief through Operational Agent','65/74 wait for scheduled Daily Brief and WhatsApp delivery','68/74 query Daily Brief through Operational Agent','69/74 verify manual Daily Brief revision and idempotency','74/74 verify all generated domain events']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
if 'BRIEF_SCHEDULER_INTERVAL_MS=500' not in text('.env.smoke'): fail('smoke brief scheduler interval missing')
if 'BRIEF_SCHEDULER_INTERVAL_MS=60000' not in text('.env.example'): fail('production brief scheduler example missing')
for doc in ['docs/mini-feature-14.md','docs/mini-feature-13.md','docs/mini-feature-12.md']:
  text(doc)
readme=text('README.md')
for n in ['0.14.0 — Daily Command Brief','☀️ Daily Command Brief','docs/mini-feature-14.md','14 Daily Command Brief     ✅','15 Briefing D-1            próxima']:
  if n not in readme: fail(f'README missing {n}')
if '| 14 — Daily Command Brief | [mini-feature-14.md](mini-feature-14.md) |' not in text('docs/README.md'): fail('docs index missing feature 14')
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

# Ensure n8n JSON remains valid.
try: json.loads(text('n8n/workflows/ecc-domain-event-gateway.json'))
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
  core_count += 1
shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
r=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stdout,r.stderr); fail('adapter emit')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias); (alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}')
x=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True); print(x.stdout.rstrip())
if x.returncode: print(x.stderr); fail('adapter tests')
ok(f'Behavioral suites pass ({core_count} core files + messaging adapters)')
print('\nMini-feature 14 Daily Command Brief validation passed.')
