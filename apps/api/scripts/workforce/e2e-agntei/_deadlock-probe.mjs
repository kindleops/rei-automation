// TEMPORARY probe (not committed): concurrent external claims vs the Workforce dispatch pass, on a scratch PG.
const port = process.argv[2]
process.env.AGENT_PG_TEST_DB_URL = `postgres://postgres@127.0.0.1:${port}/postgres`
const H = await import('../../../tests/helpers/workforce-agntei-pg.mjs')
const env = await H.agnteiWorld()
const reg = await H.registerAgnteiAgent(env, { employee_id: 'emp_scout', agent_id: 'agt_scout' })
const reg2 = await H.registerAgnteiAgent(env, { employee_id: 'emp_echo', agent_id: 'agt_echo' })
const gw = H.wfGateway(env)
const s = H.agentSession(gw, reg.token), s2 = H.agentSession(gw, reg2.token)
console.log((await s.call('workforce_link_self', { client_request_id: s.id('link'), external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_scout01' })).code)
console.log((await s2.call('workforce_link_self', { client_request_id: s2.id('link'), external_install_id: 'inst_a1b2c3d4e5f6', external_agent_id: 'agent_echo01' })).code)
await H.armRuntime(env, ['property.research'])
let stop = false; let passes = 0
const loop = (async () => { while (!stop) { try { await H.dispatchPass(env); passes++ } catch (e) { console.log('dispatch error', e.code || e.message) } } })()
const codes = {}
for (let i = 0; i < 40; i++) {
  const pref = `pid_ghi${'jklmnop'[i % 7]}${'ghijklmnop'[Math.floor(i / 7) % 10]}`
  const { a } = await H.missionWith(env, [
    { step: 'res.a', assignee: 'emp_scout', capability: 'research.property', input: { property_ref: pref, force: true }, resource_type: 'property', resource_key: pref },
    { step: 'res.b', assignee: 'emp_echo', capability: 'research.property', input: { property_ref: pref, force: true }, resource_type: 'property', resource_key: pref },
    { step: 'res.c', assignee: 'emp_research_01', capability: 'research.property', input: { property_ref: pref + 'g', force: true }, resource_type: 'property', resource_key: pref + 'g' },
  ], { key: `m-${i}` })
  const [r1, r2] = await Promise.all([
    s.call('workforce_claim_assignment', { client_request_id: s.id('c'), assignment_id: a['res.a'].assignment_id, lease_seconds: 60 }),
    s2.call('workforce_claim_assignment', { client_request_id: s2.id('c'), assignment_id: a['res.b'].assignment_id, lease_seconds: 60 }),
  ])
  for (const r of [r1, r2]) { const k = r.code + (r.result?.sqlstate ? `:${r.result.sqlstate}` : ''); codes[k] = (codes[k] || 0) + 1 }
}
stop = true; await loop
console.log('passes', passes, JSON.stringify(codes))
await env.drop()
process.exit(0)
