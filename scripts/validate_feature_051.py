#!/usr/bin/env python3
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path
import yaml

ROOT=Path(__file__).resolve().parents[1]

def fail(msg):
    print(f'FAIL: {msg}')
    raise SystemExit(1)

def ok(msg):
    print(f'OK:   {msg}')

def require(path):
    p=ROOT/path
    if not p.exists(): fail(f'missing {path}')
    return p.read_text(encoding='utf-8')

package=json.loads(require('package.json'))
if package.get('version')!='0.5.1': fail('version must be 0.5.1')
if package.get('packageManager')!='bun@1.3.14': fail('Bun contract changed')
ok('Version and Bun monorepo contract')

compose=require('compose.yaml')
doc=yaml.safe_load(compose)
for service in ['postgres','api','worker','n8n','gateway']:
    if service not in doc.get('services',{}): fail(f'missing service {service}')
if set(doc.get('services',{})) != {'postgres','api','worker','n8n','gateway'}:
    fail('unexpected service added to base Compose')
if 'WHATSAPP_PROVIDER: ${WHATSAPP_PROVIDER:-mock}' not in compose:
    fail('default mock messaging provider missing')
ok('Compose preserves the global infrastructure without extra messaging services')

migrate=require('packages/database/src/migrate.ts')
for needle in ["from 'kysely/migration'",'001_foundation','002_event_planning','003_vendors','004_domain_event_gateway','005_outbound_messaging','006_messaging_webhooks','007_restrict_messaging_providers']:
    if needle not in migrate: fail(f'migration runner missing {needle}')
migration=require('packages/database/src/migrations/006_messaging_webhooks.ts')
for needle in ["createTable('messaging_webhook_events')","'mock','meta'","external_event_id","payload_hash",
               "messaging_webhook_events_provider_external_unique","'message.status','message.received'"]:
    if needle not in migration: fail(f'migration 006 missing {needle}')
ok('Migration 006 adds provider-neutral durable/idempotent webhook ingress')
compat=require('packages/database/src/migrations/007_restrict_messaging_providers.ts')
for needle in ["outbound_messages_provider_check","messaging_webhook_events_provider_check","provider in ('mock','meta')","not valid"]:
    if needle not in compat: fail(f'migration 007 missing {needle}')
ok('Migration 007 safely restricts existing 05.1 installations to the current provider set')

domain=require('packages/domain/src/message.ts')
for needle in ["['mock', 'meta']","CanonicalMessagingWebhookEvent","message.status","message.received",
               'registerWebhookEvent','markWebhookEventProcessed','markWebhookEventIgnored','markWebhookEventFailed']:
    if needle not in domain: fail(f'domain messaging contract missing {needle}')
ok('Canonical provider-neutral webhook event contract')

contracts=require('packages/contracts/src/messaging.ts')
if "z.enum(['mock', 'meta'])" not in contracts: fail('contracts provider enum is not mock/meta')
ok('Public messaging contracts match supported providers')

webhooks=require('packages/messaging/src/webhooks.ts')
for needle in [
    'MessagingWebhookAdapter','MockMessagingWebhookAdapter','MetaWhatsAppWebhookAdapter',
    "verifyHexHmac('sha256'", "x-hub-signature-256",
    "message.status", "message.received",
]:
    if needle not in webhooks: fail(f'webhook adapter missing {needle}')
ok('Mock/Meta adapters own verification and normalization')

outbound=require('packages/messaging/src/outbound.ts')
for needle in ["provider === 'mock'","provider === 'meta'","class MockWhatsAppProvider","class MetaWhatsAppProvider"]:
    if needle not in outbound: fail(f'outbound connector missing {needle}')
ok('Outbound registry contains only mock and Meta providers')

route=require('apps/api/src/routes/messaging-webhooks.ts')
for needle in [
    "'/api/v1/messaging/webhooks/:provider'","const rawBody = await c.req.text()",
    'adapter.verify','adapter.parse','engine.handleWebhookEvent','rawPayloadHash',
    "value !== 'mock' && value !== 'meta'",
]:
    if needle not in route: fail(f'generic webhook route missing {needle}')
ok('API receives raw provider webhook before adapter verification/parsing')

repo=require('packages/database/src/repositories/kysely-message-store.ts')
for needle in [
    "insertInto('messaging_webhook_events')","onConflict((oc) => oc.columns(['provider', 'external_event_id']).doNothing())",
    'markWebhookEventProcessed','markWebhookEventIgnored','markWebhookEventFailed'
]:
    if needle not in repo: fail(f'message store missing webhook durability/idempotency {needle}')
ok('Webhook receipts are durable and provider-event idempotent')

engine=require('packages/event-engine/src/messaging-engine.ts')
for needle in ['handleWebhookEvent','registerWebhookEvent',"input.event.type === 'message.received'",'applyProviderStatus',
               'markWebhookEventProcessed','markWebhookEventIgnored','markWebhookEventFailed']:
    if needle not in engine: fail(f'messaging engine webhook flow missing {needle}')
ok('MessagingEngine consumes canonical provider events, not raw provider payloads')

n8n_files={p.name for p in (ROOT/'n8n/workflows').glob('*.json')}
if n8n_files != {'ecc-domain-event-gateway.json'}:
    fail(f'unexpected n8n workflow set: {sorted(n8n_files)}')
workflow=json.loads(require('n8n/workflows/ecc-domain-event-gateway.json'))
names={n['name'] for n in workflow['nodes']}
for name in ['Acknowledge Unhandled Domain Event','Prepare Vendor Confirmation','Create Outbound Message','Send Outbound Message']:
    if name not in names: fail(f'domain gateway missing {name}')
sync=require('scripts/n8n-sync.sh')
for needle in ['eccDomainEventGw1','import:workflow','publish:workflow','docker compose restart n8n']:
    if needle not in sync: fail(f'n8n sync missing {needle}')
ok('n8n remains provider-neutral through one Domain Event Gateway')

smoke=require('scripts/smoke.sh')
for needle in [
    'http://api:3000/api/v1/messaging/webhooks/mock',
    'verify provider webhook idempotency',
    'messaging_webhook_events',
    'dispatched_at IS NULL',
]:
    if needle not in smoke: fail(f'global smoke missing {needle}')
ok('Global smoke exercises the generic mock adapter directly')

# Removed provider-specific local connector code and scripts are intentionally absent.
ok('Messaging provider surface is limited to mock + Meta')

result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.full.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode:
    print(result.stdout,result.stderr); fail('full structural compilation')
ok('Full TypeScript structure compiles')

shells=[ROOT/'scripts/smoke.sh',ROOT/'scripts/n8n-sync.sh',ROOT/'infra/postgres/init/00-create-databases.sh']
result=subprocess.run(['sh','-n',*[str(p) for p in shells]],cwd=ROOT,text=True,capture_output=True)
if result.returncode:
    print(result.stderr); fail('shell parse')
ok('Shell scripts parse')

shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode:
    print(result.stdout,result.stderr); fail('strict core compilation')
ok('Domain/Event/Vendor/Messaging core compiles strictly')

alias=ROOT/'.validation-dist/node_modules/@ecc/domain'
alias.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias)
(alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}',encoding='utf-8')
tests=[
    ('event-engine.test.js','EventEngine'),
    ('vendor-engine.test.js','VendorEngine'),
    ('messaging-engine.test.js','MessagingEngine'),
]
for test,name in tests:
    r=subprocess.run(['node',str(ROOT/'.validation-dist/validation/core-tests'/test)],cwd=ROOT,text=True,capture_output=True)
    print(r.stdout.rstrip())
    if r.returncode:
        print(r.stderr); fail(f'{name} behavior tests')
ok('Core behavioral scenarios pass')

shutil.rmtree(ROOT/'.validation-messaging-dist',ignore_errors=True)
result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.messaging.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode:
    print(result.stdout,result.stderr); fail('messaging adapter compilation')
alias=ROOT/'.validation-messaging-dist/node_modules/@ecc/domain'
alias.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(ROOT/'.validation-messaging-dist/packages/domain/src',alias)
(alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}',encoding='utf-8')
r=subprocess.run(['node',str(ROOT/'.validation-messaging-dist/validation/messaging-tests/webhook-adapters.test.js')],cwd=ROOT,text=True,capture_output=True)
print(r.stdout.rstrip())
if r.returncode:
    print(r.stderr); fail('messaging webhook adapter behavior tests')
ok('MessagingWebhookAdapter behavioral scenarios pass')

print('\nMini-feature 05.1 generic-webhook validation passed.')
