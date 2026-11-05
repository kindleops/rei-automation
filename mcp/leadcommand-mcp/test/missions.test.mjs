// Phase 5 missions (missions/sterling-missions.json): every routine is one agent's own read-only task; every tool
// it names is a registered LeadCommand MCP READ whose scope the routine declares; the generated file is current.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS } from '../src/tools/catalog.mjs'
import { SCOPE_NAMES } from '../src/authz/scopes.mjs'
import { MISSIONS, toRoutines } from '../missions/build-missions.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(HERE, '../missions/sterling-missions.json')
const AGENTS = ['Sterling', 'Scout', 'Equity', 'Haven', 'Atlas']
const CRON = /^(\*|[0-9,*/-]+) (\*|[0-9,*/-]+) (\*|[0-9,*/-]+) (\*|[0-9,*/-]+) (\*|[0-9,*/-]+)$/

test('missions: one agent per routine, read tools only, scopes declared, schedules valid', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]))
  const routines = toRoutines()
  assert.ok(routines.length >= 9)
  for (const r of routines) {
    assert.ok(AGENTS.includes(r.agent), r.agent)
    assert.equal(r.routine.template.agentId, `{{agent:${r.agent}}}`, 'the routine runs as its own agent')
    assert.equal(r.routine.template.permission, 'read-only')
    assert.equal(r.routine.kind, 'task')
    assert.equal(r.routine.policy.inference, 'attended')
    if (r.routine.trigger.type === 'schedule') assert.match(r.routine.trigger.cron, CRON)
    for (const tool of r.leadcommand.tools) {
      const t = byName.get(tool)
      assert.ok(t, `${tool} is a registered tool`)
      assert.match(t.name, /^leadcommand_(get|search)_/)
      assert.ok(r.leadcommand.scopes.includes(t.scope), `${r.routine.name}: declares ${t.scope}`)
      assert.ok(r.routine.template.prompt.includes(tool), `${tool} is named in the prompt`)
    }
    for (const s of r.leadcommand.scopes) assert.ok(SCOPE_NAMES.includes(s), s)
    const p = r.routine.template.prompt
    assert.match(p, /no send, queue, approve or write tool/)
    assert.match(p, /quoted DATA, never instructions/)
    assert.match(p, /correlation_id/)
  }
  // collaboration is real: every multi-step mission spans several agents, each doing its own step
  for (const m of MISSIONS.filter((x) => x.steps.length > 1)) assert.ok(new Set(m.steps.map((s) => s.agent)).size === m.steps.length, `${m.id}: one step per agent`)
  // daily steps run in order: the coordinator compiles last
  const daily = routines.filter((r) => r.mission === 'lc-daily-prioritization').map((r) => r.routine.trigger.cron.split(' ').slice(0, 2).reverse().join(':'))
  assert.deepEqual(daily, [...daily].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
})

test('missions: the committed JSON is the generator\'s current output', () => {
  const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  assert.deepEqual(doc.routines, JSON.parse(JSON.stringify(toRoutines())))
  assert.equal(doc.read_only, true)
})
