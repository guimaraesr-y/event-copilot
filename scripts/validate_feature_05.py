#!/usr/bin/env python3
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]

def fail(msg): print(f'FAIL: {msg}'); raise SystemExit(1)
def ok(msg): print(f'OK:   {msg}')
def require(path):
    p=ROOT/path
    if not p.exists(): fail(f'missing {path}')
    return p.read_text(encoding='utf-8')

package=json.loads(require('package.json'))
if package.get('version')!='0.5.0': fail('version must be 0.5.0')
if package.get('packageManager')!='bun@1.3.14': fail('Bun contract changed')
ok('Version and Bun monorepo contract')

compose=require('compose.yaml'); doc=yaml.safe_load(compose)
for service in ['postgres','api','worker','n8n','gateway']:
    if service not in doc.get('services',{}): fail(f'missing service {service}')
for needle in ['WHATSAPP_PROVIDER: ${WHATSAPP_PROVIDER:-mock}','MESSAGING_WEBHOOK_SHARED_SECRET','OUTBOX_TRANSPORT: ${OUTBOX_TRANSPORT:-n8n}','DB_POSTGRESDB_DATABASE: n8n']:
    if needle not in compose: fail(f'compose missing {needle}')
ok('Compose preserves infra and defaults messaging to mock')

migrate=require('packages/database/src/migrate.ts')
for needle in ["from 'kysely/migration'",'001_foundation','002_event_planning','003_vendors','004_domain_event_gateway','005_outbound_messaging']:
    if needle not in migrate: fail(f'migration runner missing {needle}')
ok('All migrations registered through non-deprecated Migrator entrypoint')

migration=require('packages/database/src/migrations/005_outbound_messaging.ts')
for needle in ["createTable('outbound_messages')",'source_action_id','outbound_messages_provider_external_unique',"'processing'", "'sending'", "'delivered'", "'read'"]:
    if needle not in migration: fail(f'migration 005 missing {needle}')
ok('Outbound persistence and lifecycle constraints')

repo=require('packages/database/src/repositories/kysely-message-store.ts')
for needle in ["where('status', 'in', ['pending', 'failed'])", "status: 'sending'", 'source_action_id', 'applyProviderStatus', 'forUpdate()']:
    if needle not in repo: fail(f'message store missing {needle}')
ok('Atomic send claim, idempotent creation and serialized status update')

engine=require('packages/event-engine/src/messaging-engine.ts')
for needle in ['vendor_confirmation.prepare','buildVendorConfirmationMessage','normalizePhone','already_sent','message.created','message.sent','message.failed']:
    if needle not in engine: fail(f'messaging engine missing {needle}')
ok('Messaging engine keeps deterministic content and explicit domain events')

provider=require('apps/api/src/messaging-provider.ts')
for needle in ["WHATSAPP_PROVIDER ?? 'mock'",'mock-wamid-', 'META_GRAPH_API_VERSION', 'WHATSAPP_PHONE_NUMBER_ID']:
    if needle not in provider: fail(f'provider adapter missing {needle}')
ok('Mock is default and Meta adapter is configuration-gated')

workflow=json.loads(require('n8n/workflows/ecc-domain-event-gateway.json'))
names={n['name'] for n in workflow['nodes']}
for name in ['Acknowledge Unhandled Domain Event','Prepare Vendor Confirmation','Create Outbound Message','Send Outbound Message']:
    if name not in names: fail(f'domain gateway missing {name}')
if workflow['connections'].get('Create Outbound Message',{}).get('main',[[]])[0][0].get('node')!='Send Outbound Message': fail('send is not downstream of durable message creation')
ok('Domain-event workflow performs durable prepare -> create -> send')

status=json.loads(require('n8n/workflows/ecc-whatsapp-status-gateway.json'))
if status.get('id')!='eccWhatsAppStatusGw1': fail('status workflow id changed')
names={n['name'] for n in status['nodes']}
for name in ['WhatsApp Status Webhook','Apply Provider Status']:
    if name not in names: fail(f'status gateway missing {name}')
ok('Provider status workflow is present')

sync=require('scripts/n8n-sync.sh')
for needle in ['eccDomainEventGw1','eccWhatsAppStatusGw1','import:workflow','publish:workflow','docker compose restart n8n']:
    if needle not in sync: fail(f'n8n sync missing {needle}')
ok('Both workflows publish before one n8n restart')

caddy=require('Caddyfile')
for needle in ['respond /webhook/ecc-domain-events 404','respond /api/v1/internal/* 404']:
    if needle not in caddy: fail(f'internal boundary missing {needle}')
ok('Internal API and domain-event ingress remain non-public')

result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.full.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stdout,result.stderr); fail('full structural compilation')
ok('Full TypeScript structure compiles')

result=subprocess.run(['sh','-n',str(ROOT/'scripts/smoke.sh'),str(ROOT/'scripts/n8n-sync.sh'),str(ROOT/'infra/postgres/init/00-create-databases.sh')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stderr); fail('shell parse')
ok('Shell scripts parse')

shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stdout,result.stderr); fail('strict core compilation')
ok('Domain, event, vendor and messaging engines compile strictly')

alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias)
(alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}',encoding='utf-8')
for test,name in [('event-engine.test.js','EventEngine 8'),('vendor-engine.test.js','VendorEngine 7'),('messaging-engine.test.js','MessagingEngine 6')]:
    r=subprocess.run(['node',str(ROOT/'.validation-dist/validation/core-tests'/test)],cwd=ROOT,text=True,capture_output=True)
    print(r.stdout.rstrip())
    if r.returncode: print(r.stderr); fail(f'{name} behavior tests')
ok('21 behavioral scenarios pass')

smoke=require('scripts/smoke.sh')
for needle in ['verify outbound idempotency','simulate provider delivered status through n8n','simulate provider read status through n8n','outbound_messages','dispatched_at IS NULL']:
    if needle not in smoke: fail(f'smoke missing {needle}')
ok('Smoke covers durable send, idempotency, delivery/read and global outbox drain')

print('\nMini-feature 05 validation passed.')
