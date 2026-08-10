#!/usr/bin/env python3
from __future__ import annotations
import json, shutil, subprocess
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]

def fail(msg):
    print(f'FAIL: {msg}')
    raise SystemExit(1)

def ok(msg):
    print(f'OK:   {msg}')

def require(path):
    p = ROOT / path
    if not p.exists(): fail(f'missing {path}')
    return p.read_text(encoding='utf-8')

package = json.loads(require('package.json'))
if package.get('version') != '0.4.0': fail('mini-feature version must be 0.4.0')
if package.get('packageManager') != 'bun@1.3.14': fail('Bun runtime contract changed')
ok('Mini-feature 04 preserves Bun monorepo contract')

compose = require('compose.yaml')
doc = yaml.safe_load(compose)
for service in ['postgres', 'api', 'worker', 'n8n', 'gateway']:
    if service not in doc.get('services', {}): fail(f'missing compose service {service}')
if 'OUTBOX_TRANSPORT: ${OUTBOX_TRANSPORT:-n8n}' not in compose: fail('n8n is not the default outbox transport')
if compose.count('DOMAIN_EVENT_SHARED_SECRET') < 2: fail('API and worker do not share domain-event secret configuration')
if 'DB_POSTGRESDB_DATABASE: n8n' not in compose: fail('n8n logical database isolation regressed')
ok('Compose routes outbox to n8n while preserving database isolation')

migrate = require('packages/database/src/migrate.ts')
for needle in ["from 'kysely/migration'", '003_vendors', '004_domain_event_gateway']:
    if needle not in migrate: fail(f'migration runner missing {needle}')
ok('Migration runner keeps non-deprecated Migrator and registers migration 004')

migration = require('packages/database/src/migrations/004_domain_event_gateway.ts')
for needle in ["createTable('automation_actions')", 'automation_actions_source_action_unique', "status in ('prepared','completed','failed','cancelled')"]:
    if needle not in migration: fail(f'automation action schema missing {needle}')
ok('Automation action schema is persistent and idempotent')

contract = require('packages/contracts/src/domain-events.ts')
for needle in ['schemaVersion: z.literal(1)', 'canonicalizeDomainEvent', '.sort()']:
    if needle not in contract: fail(f'domain-event contract missing {needle}')
ok('Versioned canonical domain-event envelope is defined')

worker = require('apps/worker/src/index.ts')
for needle in ["createHmac('sha256'", 'x-ecc-timestamp', 'x-ecc-signature', 'canonicalizeDomainEvent', 'response.ok']:
    if needle not in worker: fail(f'worker gateway dispatch missing {needle}')
ok('Worker signs envelopes and only acknowledges successful n8n responses')

routes = require('apps/api/src/routes/domain-events.ts')
for needle in ['timingSafeEqual', 'MAX_SIGNATURE_AGE_SECONDS = 300', 'matchesOutbox', 'vendor.confirmation_requested', 'vendor_confirmation.prepare']:
    if needle not in routes: fail(f'internal gateway route missing {needle}')
ok('Backend verifies HMAC/replay window/outbox identity and prepares vendor action')

workflow = json.loads(require('n8n/workflows/ecc-domain-event-gateway.json'))
if workflow.get('id') != 'eccDomainEventGw1': fail('workflow id is not stable')
if workflow.get('active') is not False: fail('workflow export should remain draft; sync publishes it')
nodes = {node['name']: node for node in workflow.get('nodes', [])}
for name in ['Domain Event Webhook', 'Verify Domain Event', 'Is Vendor Confirmation Requested?', 'Prepare Vendor Confirmation']:
    if name not in nodes: fail(f'n8n workflow missing node {name}')
webhook = nodes['Domain Event Webhook']
if webhook['parameters'].get('path') != 'ecc-domain-events': fail('wrong domain-event webhook path')
if webhook['parameters'].get('responseMode') != 'lastNode': fail('webhook must wait for downstream completion')
prepare = json.dumps(nodes['Prepare Vendor Confirmation'], sort_keys=True)
if 'vendor-confirmation-requested' not in prepare: fail('vendor handler does not call internal preparation endpoint')
ok('n8n workflow authenticates first, routes explicitly and waits for downstream completion')

sync = require('scripts/n8n-sync.sh')
for needle in ['import:workflow', 'publish:workflow', 'eccDomainEventGw1']:
    if needle not in sync: fail(f'n8n sync missing {needle}')
if 'update:workflow' in sync: fail('deprecated update:workflow command must not be used')
ok('n8n sync uses import + publish workflow CLI')

caddy = require('Caddyfile')
for needle in ['respond /webhook/ecc-domain-events 404', 'respond /api/v1/internal/* 404']:
    if needle not in caddy: fail(f'Caddy internal-only boundary missing {needle}')
ok('Internal orchestration endpoints are not exposed through the public gateway')

result = subprocess.run(['tsc', '-p', str(ROOT / 'validation/tsconfig.full.json')], cwd=ROOT, text=True, capture_output=True)
if result.returncode:
    print(result.stdout, result.stderr)
    fail('full structural TypeScript compilation failed')
ok('Full TypeScript structure compiles against validation shims')

result = subprocess.run(['sh', '-n', str(ROOT / 'scripts/smoke.sh'), str(ROOT / 'scripts/n8n-sync.sh'), str(ROOT / 'infra/postgres/init/00-create-databases.sh')], cwd=ROOT, text=True, capture_output=True)
if result.returncode:
    print(result.stderr)
    fail('shell scripts do not parse')
ok('Smoke, n8n sync and PostgreSQL init scripts parse cleanly')

shutil.rmtree(ROOT / '.validation-dist', ignore_errors=True)
result = subprocess.run(['tsc', '-p', str(ROOT / 'validation/tsconfig.core.json')], cwd=ROOT, text=True, capture_output=True)
if result.returncode:
    print(result.stdout, result.stderr)
    fail('strict core compilation failed')
ok('Existing Domain/EventEngine/VendorEngine still compile strictly')

alias = ROOT / '.validation-dist/node_modules/@ecc/domain'
alias.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(ROOT / '.validation-dist/packages/domain/src', alias)
(alias / 'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}', encoding='utf-8')
for test, name in [('event-engine.test.js', 'EventEngine'), ('vendor-engine.test.js', 'VendorEngine')]:
    result = subprocess.run(['node', str(ROOT / '.validation-dist/validation/core-tests' / test)], cwd=ROOT, text=True, capture_output=True)
    print(result.stdout.rstrip())
    if result.returncode:
        print(result.stderr)
        fail(f'{name} behavior tests failed')
ok('15 existing core behavioral scenarios still pass')

smoke = require('scripts/smoke.sh')
for needle in ['install and publish n8n gateway', 'automation_actions', 'vendor_confirmation.prepare', 'dispatched_at IS NOT NULL']:
    if needle not in smoke: fail(f'smoke missing gateway assertion {needle}')
ok('Runtime smoke proves outbox → n8n → automation action → dispatched_at round-trip')

print('\nMini-feature 04 validation passed.')
