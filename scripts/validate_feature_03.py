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
if package.get('version')!='0.3.0': fail('mini-feature version must be 0.3.0')
if package.get('packageManager')!='bun@1.3.14': fail('Bun runtime contract changed')
ok('Mini-feature 03 preserves Bun monorepo contract')

compose=require('compose.yaml'); doc=yaml.safe_load(compose)
for service in ['postgres','api','worker','n8n','gateway']:
    if service not in doc.get('services',{}): fail(f'missing compose service {service}')
if 'DB_POSTGRESDB_DATABASE: n8n' not in compose or 'condition: service_healthy' not in compose: fail('global infra contract regressed')
ok('Compose and n8n logical database isolation preserved')

migrate=require('packages/database/src/migrate.ts')
for needle in ["from 'kysely/migration'", '002_event_planning', '003_vendors']:
    if needle not in migrate: fail(f'migration runner missing {needle}')
ok('Migration runner keeps non-deprecated Migrator and registers migration 003')

migration=require('packages/database/src/migrations/003_vendors.ts')
for table in ['vendors','event_vendors']:
    if f"createTable('{table}')" not in migration: fail(f'missing table {table}')
for constraint in ['event_vendors_event_tenant_fk','event_vendors_vendor_tenant_fk','event_vendors_event_vendor_unique','event_vendors_confirmation_status_check']:
    if constraint not in migration: fail(f'missing constraint {constraint}')
ok('Vendor schema enforces tenant FKs, uniqueness and confirmation states')

store=require('packages/database/src/repositories/kysely-vendor-store.ts')
if store.count('.transaction().execute') < 2: fail('vendor mutations are not transactionally paired with outbox')
for evt in ['createEventVendorWithOutbox','updateEventVendorWithOutbox',"insertInto('outbox_events')"]:
    if evt not in store: fail(f'vendor store missing {evt}')
ok('Event-vendor mutations share transactional outbox boundaries')

engine=require('packages/event-engine/src/vendor-engine.ts')
for evt in ['vendor.attached','vendor.confirmation_requested','vendor.confirmed','vendor.declined']:
    if evt not in engine: fail(f'VendorEngine missing {evt}')
for status in ["confirmationStatus: 'pending'", "confirmationStatus: 'requested'", "confirmationStatus: 'confirmed'", "confirmationStatus: 'declined'"]:
    if status not in engine: fail(f'confirmation state missing {status}')
ok('VendorEngine exposes explicit confirmation state transitions and domain events')

routes=require('apps/api/src/routes/vendors.ts')
for endpoint in ['/api/v1/vendors', '/confirmation-request', '/confirm', '/decline']:
    if endpoint not in routes: fail(f'API missing {endpoint}')
ok('Vendor catalog and event confirmation routes are wired')

result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.full.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stdout,result.stderr); fail('full structural TypeScript compilation failed')
ok('Full TypeScript structure compiles against validation shims')

result=subprocess.run(['sh','-n',str(ROOT/'scripts/smoke.sh'),str(ROOT/'infra/postgres/init/00-create-databases.sh')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stderr); fail('shell scripts do not parse')
ok('Smoke and PostgreSQL init scripts parse cleanly')

shutil.rmtree(ROOT/'.validation-dist',ignore_errors=True)
result=subprocess.run(['tsc','-p',str(ROOT/'validation/tsconfig.core.json')],cwd=ROOT,text=True,capture_output=True)
if result.returncode: print(result.stdout,result.stderr); fail('strict core compilation failed')
ok('Domain/EventEngine/VendorEngine compile strictly')

alias=ROOT/'.validation-dist/node_modules/@ecc/domain'; alias.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(ROOT/'.validation-dist/packages/domain/src',alias)
(alias/'package.json').write_text('{"name":"@ecc/domain","type":"module","exports":"./index.js"}',encoding='utf-8')
for test,name in [('event-engine.test.js','EventEngine'),('vendor-engine.test.js','VendorEngine')]:
    result=subprocess.run(['node',str(ROOT/'.validation-dist/validation/core-tests'/test)],cwd=ROOT,text=True,capture_output=True)
    print(result.stdout.rstrip())
    if result.returncode: print(result.stderr); fail(f'{name} behavior tests failed')
ok('15 core behavioral scenarios pass')

smoke=require('scripts/smoke.sh')
for needle in ['vendor.attached','vendor.confirmation_requested','vendor.confirmed','confirmationStatus','2026-10-17T17:30:00.000Z']:
    if needle not in smoke: fail(f'smoke missing {needle}')
ok('Runtime smoke covers planning regression and vendor confirmation lifecycle')
print('\nMini-feature 03 validation passed.')
