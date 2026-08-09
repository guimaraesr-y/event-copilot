#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
import sys
import shutil
import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def ok(message: str) -> None:
    print(f"OK:   {message}")


def require(path: str) -> str:
    p = ROOT / path
    if not p.exists():
        fail(f"missing {path}")
    return p.read_text(encoding="utf-8")


# 1) Monorepo/workspace contract
package = json.loads(require("package.json"))
if package.get("packageManager") != "bun@1.3.14":
    fail("Bun runtime must be pinned to 1.3.14")
if package.get("workspaces") != ["apps/*", "packages/*"]:
    fail("unexpected workspace layout")
ok("Bun monorepo contract")

# 2) Global infrastructure contract (structural because Docker is unavailable in this runner)
compose = require("compose.yaml")
try:
    compose_doc = yaml.safe_load(compose)
except yaml.YAMLError as exc:
    fail(f"compose.yaml is invalid YAML: {exc}")
if not isinstance(compose_doc, dict) or not isinstance(compose_doc.get("services"), dict):
    fail("compose.yaml does not contain a services mapping")
for service in ["postgres", "api", "worker", "n8n", "gateway"]:
    if not re.search(rf"^  {re.escape(service)}:\s*$", compose, re.MULTILINE):
        fail(f"compose service missing: {service}")
if "postgres:18-alpine" not in compose:
    fail("PostgreSQL 18 image is not pinned")
if "n8nio/n8n:2.34.0" not in compose:
    fail("n8n image is not pinned")
if "condition: service_healthy" not in compose:
    fail("health-gated startup is missing")
ok("Compose contains Postgres, API, worker, n8n and gateway with health-gated startup")

# 3) Data ownership contract
migration = require("packages/database/src/migrations/001_foundation.ts")
for table in ["organizations", "events", "outbox_events"]:
    if f"createTable('{table}')" not in migration:
        fail(f"migration does not create {table}")
if "references('organizations.id')" not in migration:
    fail("tenant foreign key is missing")
if "events_dates_check" not in migration or "events_guest_count_check" not in migration:
    fail("critical event database constraints are missing")
ok("Foundation migration enforces tenant and event invariants")

# 4) Transactional outbox contract
store = require("packages/database/src/repositories/kysely-event-store.ts")
if ".transaction().execute" not in store:
    fail("event persistence is not wrapped in a database transaction")
if "insertInto('events')" not in store or "insertInto('outbox_events')" not in store:
    fail("event and outbox are not persisted in the same store operation")
ok("Event persistence uses a transactional outbox boundary")

# 5) n8n isolation contract
init_script = require("infra/postgres/init/00-create-databases.sh")
if "createdb" not in init_script or "n8n" not in init_script:
    fail("n8n logical database is not provisioned")
if "DB_POSTGRESDB_DATABASE: n8n" not in compose:
    fail("n8n does not point to its isolated logical database")
ok("Application and n8n persistence are logically isolated")


# 6) Full project TypeScript syntax/import-shape validation using local shims.
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

# 7) Shell entrypoints parse cleanly.
result = subprocess.run(
    ["sh", "-n", str(ROOT / "scripts/smoke.sh"), str(ROOT / "infra/postgres/init/00-create-databases.sh")],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
if result.returncode != 0:
    print(result.stderr)
    fail("shell entrypoint validation failed")
ok("Shell entrypoints parse cleanly")

# 8) Compile + execute pure domain/event-engine tests using locally available tsc/node.
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
ok("Core domain/event-engine TypeScript compiles")

# Create the workspace alias Node needs for the compiled validation output.
alias_dir = ROOT / ".validation-dist/node_modules/@ecc/domain"
if alias_dir.exists():
    shutil.rmtree(alias_dir)
shutil.copytree(ROOT / ".validation-dist/packages/domain/src", alias_dir)
(alias_dir / "package.json").write_text(
    '{"name":"@ecc/domain","type":"module","exports":"./index.js"}',
    encoding="utf-8",
)

compiled_test = ROOT / ".validation-dist/validation/core-tests/event-engine.test.js"
result = subprocess.run(
    ["node", str(compiled_test)],
    cwd=ROOT,
    text=True,
    capture_output=True,
)
print(result.stdout.rstrip())
if result.returncode != 0:
    print(result.stderr)
    fail("core behavior tests failed")
ok("EventEngine behavior tests pass")

print("\nFoundation validation passed.")
