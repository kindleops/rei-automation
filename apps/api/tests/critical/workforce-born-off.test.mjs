// Workforce Phase A — BORN OFF (docs/WORKFORCE.md §9), in the style of rc-8.5.21-born-off.test.mjs (whose
// completeness guard registers WORKFORCE_ENABLED and WORKFORCE_MODEL_INTERPRET): no handler registers,
// no route service is built and the tick adds nothing unless WORKFORCE_ENABLED=1 AND the runtime gate;
// the DB never claims the kinds until an operator arms them; the dispatch schedule is seeded disabled.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORKFORCE_FLAG, WORKFORCE_MODEL_INTERPRET_FLAG, WORKFORCE_KINDS, WORKFORCE_DISPATCH_SCHEDULE, WORKFORCE_ORG_ID, workforceEnabled, modelInterpretEnabled } from '../../src/lib/workforce/config.js'
import { workforceRuntimeHandlers, getWorkforceRouteServices, __resetWorkforceWiring } from '../../src/lib/ai/workforce-runtime-wiring.js'
import { DEFAULT_ORG_ID } from '../../src/lib/agent/runtime/pg-store.js'
import { SEED_EMPLOYEES } from '../../src/lib/workforce/org/seed.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const REPO = path.resolve(SRC, '../../..')

test('the switches: only the literal 1 arms; the interpreter never arms without Workforce', () => {
  assert.equal(WORKFORCE_FLAG, 'WORKFORCE_ENABLED')
  assert.equal(WORKFORCE_MODEL_INTERPRET_FLAG, 'WORKFORCE_MODEL_INTERPRET')
  for (const v of [undefined, '', '0', 'true', 'on', 'yes', 'TRUE', ' 2 ']) {
    assert.equal(workforceEnabled({ [WORKFORCE_FLAG]: v }), false, String(v))
    assert.equal(modelInterpretEnabled({ [WORKFORCE_FLAG]: '1', [WORKFORCE_MODEL_INTERPRET_FLAG]: v }), false, String(v))
  }
  assert.equal(workforceEnabled({ [WORKFORCE_FLAG]: ' 1 ' }), true)
  assert.equal(modelInterpretEnabled({ [WORKFORCE_MODEL_INTERPRET_FLAG]: '1' }), false)
  assert.equal(WORKFORCE_ORG_ID, DEFAULT_ORG_ID, 'the same single org as the runtime')
})

test('wiring: no handler registers and no route service is built by default', async () => {
  __resetWorkforceWiring()
  assert.deepEqual(workforceRuntimeHandlers({}), {})
  assert.deepEqual(workforceRuntimeHandlers({ WORKFORCE_ENABLED: '1' }), {}, 'the runtime gate (AGENT_RUNTIME_ENABLED) is still off')
  assert.deepEqual(workforceRuntimeHandlers({ AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1' }), {}, 'Workforce itself is off')
  assert.deepEqual(workforceRuntimeHandlers({ AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1', WORKFORCE_ENABLED: 'true' }), {})
  assert.equal(await getWorkforceRouteServices({ env: {} }), null)
  // armed: exactly the three kinds — and nothing is constructed (no pool, no store) until a job runs
  const h = workforceRuntimeHandlers({ AGENT_ENABLED: '1', AGENT_RUNTIME_ENABLED: '1', WORKFORCE_ENABLED: '1' })
  assert.deepEqual(Object.keys(h).sort(), [...WORKFORCE_KINDS].sort())
  assert.equal(globalThis[Symbol.for('lc.workforce.deps')], undefined)
  __resetWorkforceWiring()
})

test('the tick registers the handlers by spreading workforceRuntimeHandlers() (inert unless enabled)', () => {
  const route = fs.readFileSync(path.join(SRC, 'app/api/internal/agent/runtime/tick/route.js'), 'utf8')
  assert.match(route, /import \{ workforceRuntimeHandlers \} from '@\/lib\/ai\/workforce-runtime-wiring\.js'/)
  assert.match(route, /\.\.\.workforceRuntimeHandlers\(\)/)
})

test('the DB never claims a Workforce kind until armed, and the dispatch schedule is seeded disabled', (t) => {
  assert.deepEqual([...WORKFORCE_KINDS], ['workforce.coo_plan', 'workforce.dispatch', 'workforce.mission_review'])
  assert.equal(WORKFORCE_DISPATCH_SCHEDULE.name, 'workforce-dispatch')
  assert.equal(WORKFORCE_DISPATCH_SCHEDULE.interval_seconds, 60)
  const dir = path.join(REPO, 'supabase/migrations')
  const files = fs.readdirSync(dir).filter((f) => /^PROPOSED_.*\.sql$/.test(f) && !/rollback/.test(f))
  // no migration arms or enables a Workforce kind
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
    assert.doesNotMatch(sql, /workforce\.(?:coo_plan|dispatch|mission_review)['"]?\s*[,:]\s*(?:jsonb_build_object\(|\{)[^)}]*['"]?enabled['"]?\s*[,:]\s*true/i, `${f} enables a Workforce kind`)
    assert.doesNotMatch(sql, /workforce\.(?:coo_plan|dispatch|mission_review)['"]?\s*[,:]\s*(?:jsonb_build_object\(|\{)[^)}]*armed_by/i, `${f} arms a Workforce kind`)
  }
  const seeds = files.filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes("'workforce-dispatch'"))
  if (!seeds.length) { t.diagnostic('the Workforce migration is not on this branch (built separately): the schedule seed is checked at integration'); return }
  for (const f of seeds) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
    for (const m of sql.matchAll(/runtime_upsert_schedule\(([\s\S]*?)\);/g)) if (m[1].includes('workforce-dispatch')) assert.match(m[1], /::jsonb\s*,\s*false\s*,/, `${f}: workforce-dispatch is seeded enabled`)
  }
})

test('the JS seed matches the migration seed row for row (ids, roles, departments, names, codes, managers)', (t) => {
  const f = path.join(REPO, 'supabase/migrations/PROPOSED_20261022100100_workforce_seed.sql')
  if (!fs.existsSync(f)) { t.diagnostic('the seed migration is on feat/workforce-db (built separately): checked at integration'); return }
  const sql = fs.readFileSync(f, 'utf8')
  const rows = [...sql.matchAll(/\{"employee_id": "emp_[^}]*\}/g)].map((m) => JSON.parse(m[0]))
  assert.equal(rows.length, SEED_EMPLOYEES.length)
  for (const r of rows) {
    const e = SEED_EMPLOYEES.find((x) => x.employee_id === r.employee_id)
    assert.ok(e, r.employee_id)
    for (const k of ['kind', 'role_key', 'department_key', 'display_name', 'employee_code']) assert.equal(e[k], r[k], `${r.employee_id}.${k}`)
    assert.equal(e.manager_employee_id ?? null, r.manager_employee_id ?? null, `${r.employee_id}.manager`)
  }
})
