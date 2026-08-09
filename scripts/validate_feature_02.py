#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def ok(message: str) -> None:
    print(f"OK:   {message}")


def require(path: str) -> str:
    file = ROOT / path
    if not file.exists():
        fail(f"missing {path}")
    return file.read_text(encoding="utf-8")


package = json.loads(require("package.json"))
if package.get("packageManager") != "bun@1.3.14":
    fail("Bun runtime contract changed unexpectedly")
if package.get("version") != "0.2.0":
    fail("mini-feature package version must be 0.2.0")
ok("Mini-feature 02 keeps the Bun monorepo contract")

compose = require("compose.yaml")
try:
    compose_doc = yaml.safe_load(compose)
except yaml.YAMLError as exc:
    fail(f"compose.yaml is invalid YAML: {exc}")
services = compose_doc.get("services", {}) if isinstance(compose_doc, dict) else {}
for service in ["postgres", "api", "worker", "n8n", "gateway"]:
    if service not in services:
        fail(f"compose service missing: {service}")
if "condition: service_healthy" not in compose:
    fail("health-gated startup was lost")
if "DB_POSTGRESDB_DATABASE: n8n" not in compose:
    fail("n8n logical database isolation was lost")
ok("Global Compose infrastructure remains compatible with mini-feature 01")

migrate = require("packages/database/src/migrate.ts")
if "from 'kysely/migration'" not in migrate:
    fail("Migrator must use the non-deprecated kysely/migration entrypoint")
if "002_event_planning" not in migrate:
    fail("002_event_planning is not registered")
ok("Migration runner includes 002_event_planning without deprecated Migrator import")

migration = require("packages/database/src/migrations/002_event_planning.ts")
for table in [
    "event_templates",
    "event_template_tasks",
    "event_template_milestones",
    "event_tasks",
    "event_milestones",
]:
    if f"createTable('{table}')" not in migration:
        fail(f"planning migration does not create {table}")
for constraint in [
    "events_template_tenant_fk",
    "event_template_tasks_template_tenant_fk",
    "event_template_milestones_template_tenant_fk",
    "event_tasks_event_tenant_fk",
    "event_milestones_event_tenant_fk",
]:
    if constraint not in migration:
        fail(f"tenant planning constraint missing: {constraint}")
if "event_template_tasks_due_time_check" not in migration or "event_template_tasks_offset_check" not in migration:
    fail("template scheduling constraints are missing")
ok("Planning schema contains tenant-scoped templates, tasks and milestones with scheduling constraints")

store = require("packages/database/src/repositories/kysely-event-store.ts")
for needle in ["insertInto('events')", "insertInto('event_tasks')", "insertInto('event_milestones')", "insertInto('outbox_events')"]:
    if needle not in store:
        fail(f"atomic event plan store is missing {needle}")
if ".transaction().execute" not in store:
    fail("event plan is not persisted inside a transaction")
ok("Event + tasks + milestones + outbox share a transactional persistence boundary")

engine = require("packages/event-engine/src/event-engine.ts")
for needle in ["event.plan_initialized", "scheduleRelativeToEvent", "findTemplateSnapshot", "source: 'template'"]:
    if needle not in engine:
        fail(f"EventEngine planning behavior missing: {needle}")
ok("EventEngine instantiates template snapshots and emits event.plan_initialized")

routes = require("apps/api/src/routes/event-templates.ts") + require("apps/api/src/routes/events.ts")
for endpoint_fragment in [
    "/api/v1/event-templates",
    "/tasks",
    "/milestones",
]:
    if endpoint_fragment not in routes:
        fail(f"API surface missing planning endpoint fragment {endpoint_fragment}")
ok("Template and event planning endpoints are wired")

result = subprocess.run(
    ["tsc", "-p", str(ROOT / "validation/tsconfig.full.json")],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    print(result.stdout)
    print(result.stderr)
    fail("full TypeScript structural compilation failed")
ok("Full project TypeScript structure compiles against validation shims")

result = subprocess.run(
    ["sh", "-n", str(ROOT / "scripts/smoke.sh"), str(ROOT / "infra/postgres/init/00-create-databases.sh")],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    print(result.stderr)
    fail("shell entrypoint validation failed")
ok("Smoke and PostgreSQL initialization scripts parse cleanly")

shutil.rmtree(ROOT / ".validation-dist", ignore_errors=True)
result = subprocess.run(
    ["tsc", "-p", str(ROOT / "validation/tsconfig.core.json")],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    print(result.stdout)
    print(result.stderr)
    fail("core TypeScript compilation failed")
ok("Domain/EventEngine TypeScript compiles strictly")

alias_dir = ROOT / ".validation-dist/node_modules/@ecc/domain"
alias_dir.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(ROOT / ".validation-dist/packages/domain/src", alias_dir)
(alias_dir / "package.json").write_text(
    '{"name":"@ecc/domain","type":"module","exports":"./index.js"}',
    encoding="utf-8",
)

compiled_test = ROOT / ".validation-dist/validation/core-tests/event-engine.test.js"
result = subprocess.run(["node", str(compiled_test)], cwd=ROOT, text=True, capture_output=True)
print(result.stdout.rstrip())
if result.returncode != 0:
    print(result.stderr)
    fail("EventEngine behavior tests failed")
ok("EventEngine behavior tests pass")

smoke = require("scripts/smoke.sh")
for expected in [
    "2026-09-17T12:00:00.000Z",
    "2026-10-10T13:00:00.000Z",
    "2026-10-16T21:00:00.000Z",
    "event.plan_initialized",
]:
    if expected not in smoke:
        fail(f"runtime smoke coverage missing {expected}")
ok("Runtime smoke covers template instantiation, local timezone dates and both event outbox messages")

print("\nMini-feature 02 validation passed.")
