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
if version!='0.11.0': fail(f'version expected 0.11.0, got {version}')
for n in ['015_dependency_engine','migration015DependencyEngine']:
  if n not in text('packages/database/src/migrate.ts'): fail(f'migrate missing {n}')
for n in ["createTable('dependency_evaluations')","createTable('dependency_impacts')",'dependency_evaluations_source_unique','dependency_impacts_source_unique','dependency_impacts_status_check']:
  if n not in text('packages/database/src/migrations/015_dependency_engine.ts'): fail(f'migration 015 missing {n}')
for n in ['DependencyEngine','evaluateAppliedChange','applySuggestion','applySuggestionsForProposal','resolveReview']:
  if n not in text('packages/event-engine/src/dependency-engine.ts'): fail(f'dependency engine missing {n}')
for n in ['findBySourceChangeEvent','forUpdate','Task due date changed after dependency evaluation','Vendor arrival changed after dependency evaluation']:
  if n not in text('packages/database/src/repositories/kysely-dependency-store.ts'): fail(f'dependency store missing {n}')
for n in ['/api/v1/dependencies','/api/v1/dependencies/:id/apply','/api/v1/change-proposals/:id/dependencies/apply-suggestions']:
  if n not in text('apps/api/src/routes/dependencies.ts'): fail(f'dependency API missing {n}')
for n in ['get_dependency_impacts','apply_dependency_suggestion','apply_dependency_suggestions','resolve_dependency_review','DEPENDÊNCIAS ABERTAS']:
  if n not in text('packages/event-engine/src/operational-agent.ts'): fail(f'agent dependency integration missing {n}')
for n in ["message.eventType === 'change.applied'",'evaluateAppliedChange']:
  if n not in text('apps/worker/src/index.ts'): fail(f'worker dependency hook missing {n}')
for n in ['dependency.detected','dependency.evaluation_completed','dependency.applied','dependency.resolved','dependency.dismissed']:
  if n not in text('packages/event-engine/src/operational-projector.ts'): fail(f'projector missing {n}')
for n in ['48/55 wait for dependency evaluation','50/55 apply safe dependency suggestions','55/55 verify all generated domain events']:
  if n not in text('scripts/smoke.sh'): fail(f'smoke missing {n}')
for doc in ['docs/mini-feature-01.md','docs/mini-feature-08.1.md','docs/mini-feature-11.md','docs/mini-feature-10.md','docs/openrouter-operational-agent.md']:
  text(doc)
for stale in ['OPENROUTER_AGENT_PATCH.md','PATCH.md','VALIDATION.txt']:
  if (ROOT/stale).exists(): fail(f'stale feature documentation remains at repository root: {stale}')
readme=text('README.md')
for n in ['🎛️ Event Command Center','Dependency Engine','docs/mini-feature-11.md','🧪 Validação','🗺️ Roadmap']:
  if n not in readme: fail(f'README missing {n}')

for cfg in ['validation/tsconfig.full.json','validation/tsconfig.core.json','validation/tsconfig.messaging.json']:
  r=subprocess.run(['tsc','--noEmit','-p',str(ROOT/cfg)],cwd=ROOT,text=True,capture_output=True)
  if r.returncode: print(r.stdout,r.stderr); fail(cfg)
ok('TypeScript structural/core/messaging compilation')

shells=['scripts/smoke.sh','scripts/n8n-sync.sh','scripts/smoke-env.sh','scripts/ollama-setup.sh','scripts/ollama-command-check.sh']
r=subprocess.run(['sh','-n',*[str(ROOT/s) for s in shells]],cwd=ROOT,text=True,capture_output=True)
if r.returncode: print(r.stderr); fail('shell syntax')
ok('Shell scripts parse')

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
print('\nMini-feature 11 Dependency Engine validation passed.')
