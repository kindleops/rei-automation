import fs from 'node:fs'
const dir = process.argv[2], out = process.argv[3]
const order = ['lc_mcp_reader','lc_mcp_conversation_intel','lc_mcp_corpus_census','lc_mcp_acquisition_reads','lc_mcp_full_history','action_gateway_ohg','action_gateway_standing_reply','ai_generated_outbound','action_gateway_agent_message']
const links = order.map(id => {
  const log = fs.readFileSync(`${dir}/${id}.log`, 'utf8').split('\n')
  const steps = log.filter(l => /^\s+(ok|FAIL)\s/.test(l)).map(l => {
    const m = l.match(/^\s+(ok|FAIL)\s+(.*?)(?: \((\d+) ms\))?$/)
    return { ok: m[1] === 'ok', step: m[2], ms: m[3] ? Number(m[3]) : null }
  })
  const ms = re => steps.filter(s => re.test(s.step)).map(s => s.ms)
  const fp = (log.join('\n').match(/restored the pre-apply fingerprint (\w+)/) || [])[1] || null
  return {
    id,
    result: log.some(l => l.includes(`[${id}] PASS`)) ? 'PASS' : 'FAIL',
    setup_steps: steps.filter(s => s.step.startsWith('setup')).length,
    timings_ms: {
      pretest: ms(/cycle 1: pretest .*\.sql/)[0], apply: ms(/cycle 1: APPLY/)[0], posttest: ms(/cycle 1: posttest/).reduce((a,b)=>a+b,0),
      rollback: ms(/ROLLBACK FILE/).reduce((a,b)=>a+b,0), rollback_posttest: ms(/^rollback posttest/).reduce((a,b)=>a+b,0),
      reapply: ms(/cycle 2 .*APPLY/)[0], reapply_posttest: ms(/cycle 2 .*posttest/).reduce((a,b)=>a+b,0),
    },
    pretest_left_no_trace: steps.some(s => /cycle 1: pretest left no trace/.test(s.step) && s.ok),
    rollback_fingerprint_restored: fp !== null, fingerprint: fp,
    reapply_posttest_ok: steps.some(s => /cycle 2 .*posttest/.test(s.step) && s.ok),
    steps,
  }
})
fs.writeFileSync(out, JSON.stringify({
  kind: 'leadcommand_migration_rehearsal', date: '2026-10-30', branch: 'feat/hidden-gold-full',
  environment: 'disposable PostgreSQL 17 clusters (private, unix socket only), one fresh cluster and database per link, schema built from emulation fixtures + real prerequisite migrations',
  production_copy: false,
  statement: 'This is a disposable-schema rehearsal. It is NOT a rehearsal on a production copy; that requires the owner\'s copy (scripts/db/prod-copy-rehearsal.mjs).',
  runner: 'scripts/db/run-migration-test.mjs (manifest scripts/db/migration-tests.manifest.mjs)',
  cycle: ['setup','pretest','pretest leaves no trace','apply','posttest','rollback','rollback posttest','fingerprint == pre-apply','pretest','apply','posttest'],
  recommended_production_order: order,
  all_pass: links.every(l => l.result === 'PASS' && l.rollback_fingerprint_restored && l.reapply_posttest_ok),
  born_off: {
    action_gateway_ohg: 'no standing grants exist after apply; the four OHG actions are callable only with owner-minted grants',
    action_gateway_standing_reply: 'posttest asserts no grant carries standing_seller_facing (born OFF)',
    action_gateway_agent_message: 'posttest asserts agent_text_refusal() = AGENT_TEXT_KILL_SWITCH_OFF; ai_agent_text_enabled absent',
    reader_links_and_ai_generated_outbound: 'add no switch, no grant and no send path',
  },
  owner_boundary: 'pretest / posttest / rollback-posttest fixtures are disposable-only (run-migration-test.mjs, owner boundary 2026-10-15); production gets the read-only checks of docs/PI-MIGRATION-REHEARSAL.md sections 4 and 7',
  per_link: { description: 'each link alone on a fresh private cluster, scripts/db/run-migration-test.mjs', links },
  reader_family_one_database: {
    description: 'links 1-5 applied cumulatively on ONE database (each link\'s emulation, then pretest/apply/posttest), the section 7 reader validation, rollbacks 5->1 with rollback posttests, catalog compared with a twin database holding the same emulations and no link',
    log: 'docs/prod-copy-rehearsal/pi-2026-10-30/reader_family_chain.log',
    result: fs.readFileSync(`${process.argv[4]}/reader_family_chain.log`, 'utf8').includes('FINGERPRINT RESTORED') && fs.readFileSync(`${process.argv[4]}/reader_family_chain.log`, 'utf8').includes('failures: 0') ? 'PASS' : 'FAIL',
  },
  production_shaped_all_nine_one_database: {
    description: 'scripts/db/prod-copy-rehearsal.mjs on a SYNTHETIC production-shaped dump (scripts/db/prod-copy-synthetic-build.mjs: the release chain to #28 + reader 1.0 + the synthetic corpus), private PG17 cluster: guard, validate-backup, restore, prereqs, migrate (#29, #30, #31, A, B: two cycles, rollback in reverse, fingerprint + row counts restored, V-A / V-B / V-OFF, switches OFF), census (applies reader 1.1 and 1.2 in the documented order), then link 5 by hand (pretest, apply, section 7 validation, rollback, rollback posttest, fingerprint, re-apply). Link 1 was part of the dump (baseline), not applied by this run. Synthetic data, not production data.',
    evidence: 'docs/prod-copy-rehearsal/pi-2026-10-30/prodshape/',
    migrate: (() => { const m = JSON.parse(fs.readFileSync('docs/prod-copy-rehearsal/pi-2026-10-30/prodshape/migrate.json', 'utf8')); return { status: m.status, timings: m.results.timings.map(({ cycle, link, pretest_ms, apply_ms, posttest_ms, posttest, rollback_ms, rollback_posttest_ms }) => ({ cycle, link, pretest_ms, apply_ms, posttest_ms, posttest, rollback_ms, rollback_posttest_ms })), checks: { fingerprint_pre_apply: m.results.checks.fingerprint_pre_apply, fingerprint_after_rollback: m.results.checks.fingerprint_after_rollback, rollback_restored_row_counts: m.results.checks.rollback_restored_row_counts, reapply_matches_first_apply: m.results.checks.reapply_matches_first_apply, verify_after_cycle1: m.results.checks.verify_after_cycle1, switches_after_reapply: m.results.checks.switches_after_reapply } } })(),
    census_status: JSON.parse(fs.readFileSync('docs/prod-copy-rehearsal/pi-2026-10-30/prodshape/census.json', 'utf8')).status,
    full_history: { log: 'docs/prod-copy-rehearsal/pi-2026-10-30/prodshape/full_history.log', fingerprint_restored: fs.readFileSync(`${process.argv[4]}/prodshape_full_history.log`, 'utf8').includes('FINGERPRINT RESTORED'), posttest: 'advisory_fail: it asserts the runner emulation\'s seed thread P5, absent from the synthetic corpus (same treatment as #30 in the tool)' },
  },
  not_done: ['a rehearsal on a copy of PRODUCTION (needs the owner\'s backup and authorizations A1-A7 of docs/PRODUCTION-COPY-REHEARSAL.md)', 'prod-copy-rehearsal.mjs does not yet know link 5 (lc_mcp_full_history); it was applied by hand on the copy'],
}, null, 2) + '\n')
console.log(links.map(l => `${l.id} ${l.result} setup=${l.setup_steps} ${JSON.stringify(l.timings_ms)} fp=${l.fingerprint}`).join('\n'))
