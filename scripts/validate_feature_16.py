#!/usr/bin/env python3
from pathlib import Path
import json, sys

ROOT=Path(__file__).resolve().parents[1]
def text(path):
    p=ROOT/path
    if not p.exists(): fail(f'missing {path}')
    return p.read_text(encoding='utf-8')
def fail(message):
    print(f'[feature16] FAIL: {message}',file=sys.stderr);raise SystemExit(1)

def require(path,*needles):
    value=text(path)
    for needle in needles:
        if needle not in value: fail(f'{path} missing {needle}')
    return value

package=json.loads(text('package.json'))
if package.get('version')!='0.16.0': fail('package version must be 0.16.0')
if package.get('scripts',{}).get('validate:feature')!='python3 scripts/validate_feature_16.py': fail('validate:feature must target Feature 16 validator')

require('packages/database/src/migrate.ts','020_event_day_mode','migration020EventDayMode')
require('packages/database/src/migrations/020_event_day_mode.ts','event_day_sessions','event_day_activity','actual_arrival_at','actual_departure_at')
require('packages/database/src/db-types.ts','EventDaySessionsTable','EventDayActivityTable','actual_arrival_at','actual_departure_at')
require('packages/domain/src/event-day.ts','EventDaySnapshot','EventDayStore','not_started','on_track','attention','critical','completed')
require('packages/domain/src/index.ts',"export * from './event-day.ts'")
require('packages/database/src/index.ts',"export * from './repositories/kysely-event-day-store.ts'")
require('packages/database/src/repositories/kysely-event-day-store.ts','class KyselyEventDayStore','pg_advisory_xact_lock','actual_arrival_at','actual_departure_at')
require('packages/event-engine/src/index.ts',"export * from './event-day-engine.ts'")
engine=require('packages/event-engine/src/event-day-engine.ts','class EventDayEngine','arrivalGraceMinutes','criticalLateMinutes','actualArrivalAt','nextActions','event_day.vendor_arrived','event_day.vendor_departed')
if 'plannedArrivalAt' not in engine or 'actualArrivalAt' not in engine: fail('Event Day engine must keep planned and actual supplier time separately')

require('apps/api/src/app.ts','KyselyEventDayStore','EventDayEngine','registerEventDayRoutes')
require('apps/api/src/routes/event-day.ts','/api/v1/events/:eventId/event-day','/start',"/arrive'","/depart'","/complete'")
require('apps/api/src/routes/agent.ts','EventDayNotFoundError','EventDayConflictError','EventDayValidationError')
agent=require('packages/event-engine/src/operational-agent.ts','get_event_day_status','start_event_day','mark_event_day_vendor_arrived','mark_event_day_vendor_departed','complete_event_day')
for guard in ['isExplicitEventDayStart','isExplicitVendorArrival','isExplicitVendorDeparture','isExplicitEventDayCompletion']:
    if guard not in agent: fail(f'Operational Agent missing server guard {guard}')
provider=require('packages/event-engine/src/operational-agent-provider.ts','get_event_day_status','mark_event_day_vendor_arrived','complete_event_day')

smoke=require('scripts/smoke.sh','82/90 create Event Day smoke event','90/90 verify all generated domain events were acknowledged','actual_arrival_at','get_event_day_status','mark_event_day_vendor_arrived','complete_event_day')
if "AND type='d_minus_1' AND event_id=" in smoke: fail('Feature 15 D-1 smoke regression: daily_briefs column must be brief_type')
if '/82' in smoke: fail('smoke step denominator still contains /82')

require('validation/core-tests/event-day-engine.test.ts','8/8 behavioral scenarios passed','planned arrival is preserved','Event Day completion is idempotent')
require('validation/core-tests/operational-agent.test.ts','31/31 behavioral scenarios passed','get_event_day_status','mark_event_day_vendor_arrived')
require('validation/core-tests/operational-agent-provider.test.ts','deterministic Event Day routing: 5/5')
require('docs/mini-feature-16.md','Mini Feature 16','Event Day Mode','actual_arrival_at','17 Dashboard')
require('docs/README.md','16 — Event Day Mode')
require('README.md','Event Day Mode','16 Event Day Mode           ✅','17 Dashboard                próxima')

print('[feature16] static validation passed')
