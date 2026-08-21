#!/usr/bin/env python3
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]


def fail(message):
    print(f'[feature16.1] FAIL: {message}', file=sys.stderr)
    raise SystemExit(1)


def text(path):
    p = ROOT / path
    if not p.exists():
        fail(f'missing {path}')
    return p.read_text(encoding='utf-8')


def require(path, *needles):
    value = text(path)
    for needle in needles:
        if needle not in value:
            fail(f'{path} missing {needle}')
    return value


package = json.loads(text('package.json'))

if package.get('version') != '0.16.1':
    fail('package version must be 0.16.1')

if (
    package.get('scripts', {}).get('validate:feature')
    != 'python3 scripts/validate_feature_161.py'
):
    fail('validate:feature must target Feature 16.1 validator')


require(
    'packages/database/src/migrate.ts',
    '020_event_day_mode',
    '021_event_day_operations',
    'migration021EventDayOperations',
)

migration = require(
    'packages/database/src/migrations/021_event_day_operations.ts',
    'event_day_settings',
    'phase',
    'event_day_kind',
    'previous_event_status',
    'completion_reason',
    'event_day_sessions_one_active_idx',
)

bad_constraint_chains = [
    (
        "event_tasks_phase_check',sql`phase in ('planning','event_day')`)"
        "\n      .addCheckConstraint"
    ),
    (
        "event_day_sessions_previous_status_check',"
        "sql`previous_event_status in ('draft','planning','confirmation','ready')`)"
        "\n      .addCheckConstraint"
    ),
    (
        "event_day_sessions_event_unique',['organization_id','event_id'])"
        "\n      .dropConstraint"
    ),
    (
        "event_day_sessions_completion_reason_check')"
        "\n      .dropConstraint"
    ),
    (
        "event_tasks_event_day_shape_check')"
        "\n      .dropConstraint"
    ),
]

for chain in bad_constraint_chains:
    if chain in migration:
        fail(
            'migration 021 chains terminal Kysely constraint builders; '
            'execute each constraint separately'
        )

if (
    "where status = 'active'" not in migration
    and "where status='active'" not in migration
):
    fail(
        'migration must allow history while limiting '
        'one active Event Day session'
    )


require(
    'packages/database/src/db-types.ts',
    'EventDaySettingsTable',
    'event_day_settings',
    'event_day_kind',
    'previous_event_status',
    'completion_reason',
)

domain = require(
    'packages/domain/src/event-day.ts',
    'disabled',
    'EventDayTaskKind',
    'checklist',
    'operation',
    'incident',
    'enable(input',
    'disable(input',
    'createTask(input',
    'updateTask(input',
)

store = require(
    'packages/database/src/repositories/kysely-event-day-store.ts',
    'event_day_settings',
    'async enable',
    'async disable',
    "phase:'event_day'",
    'event_day_kind',
    'previous_event_status',
    'completion_reason',
)

engine = require(
    'packages/event-engine/src/event-day-engine.ts',
    'async enable',
    'async disable',
    'async createTask',
    'async startTask',
    'async completeTask',
    'async resolveIncident',
    'criticalOpenIncidents',
    'event_day.incident_resolved',
)

complete_start = engine.find('async complete(')
create_task_start = engine.find('async createTask(')

if (
    complete_start != -1
    and create_task_start != -1
    and "status:'completed'"
    in engine[complete_start:create_task_start]
):
    fail(
        'complete Event Day must not hard-code '
        'business event status completed'
    )


routes = require(
    'apps/api/src/routes/event-day.ts',
    "/enable'",
    "/disable'",
    "/tasks'",
    "/tasks/:taskId/start'",
    "/tasks/:taskId/complete'",
    "/incidents/:taskId/resolve'",
)

agent = require(
    'packages/event-engine/src/operational-agent.ts',
    'enable_event_day',
    'disable_event_day',
    'create_event_day_task',
    'start_event_day_task',
    'complete_event_day_task',
    'resolve_event_day_incident',
    'isExplicitEventDayEnable',
    'isExplicitEventDayDisable',
    'isExplicitEventDayIncident',
)

provider = require(
    'packages/event-engine/src/operational-agent-provider.ts',
    'enable_event_day',
    'disable_event_day',
    'create_event_day_task',
    'resolve_event_day_incident',
)

smoke = require(
    'scripts/smoke.sh',
    '82/102 create Event Day smoke events',
    '102/102 verify all generated domain events were acknowledged',
    'event_day_kind',
    'enable_event_day',
    'disable_event_day',
    'resolve_event_day_incident',
)

if "AND type='d_minus_1' AND event_id=" in smoke:
    fail('Feature 15 brief_type regression')

if 'O fotógrafo chegou agora' in smoke:
    fail(
        'Event Day smoke must retain ASCII-safe supplier wording'
    )

for name in [
    'COMPOSE_PROJECT_NAME',
    'WHATSAPP_PROVIDER',
    'API_WHATSAPP_PROVIDER',
]:
    if name not in smoke:
        fail(f'smoke safety guard missing {name}')


require(
    'validation/core-tests/event-day-engine.test.ts',
    '12/12 behavioral scenarios passed',
    'disabled by default',
    'restores previous event lifecycle',
    'another event remains independent',
)

require(
    'validation/core-tests/operational-agent-provider.test.ts',
    'deterministic Event Day routing: 12/12',
    'enable_event_day',
    'disable_event_day',
    'resolve_event_day_incident',
)

require(
    'validation/core-tests/operational-agent.test.ts',
    '36/36 behavioral scenarios passed',
    'get_event_day_status',
    'complete_event_day',
)

require(
    'docs/mini-feature-16.md',
    'Atualização 16.1',
    'mini-feature-16-1.md',
)

require(
    'docs/mini-feature-16-1.md',
    'Mini Feature 16.1',
    'Opt-in',
    'event_day_kind',
    '102/102',
    '17 — Dashboard',
)

require(
    'docs/README.md',
    '16.1 — Event Day Operations',
)

require(
    'README.md',
    'Feature 16.1',
    '16.1 Event Day Operations   ✅',
    '17 Dashboard                próxima',
)

print('[feature16.1] static validation passed')