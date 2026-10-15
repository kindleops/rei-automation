// Migration tests the runner (run-migration-test.mjs) knows how to execute on a
// disposable PostgreSQL. Runner, guard, fixture linter and lexer are ported
// verbatim from rc-8.5.15.1 (8247f761); this manifest lists the 8.5.19 entries.
// When the two branches meet, merge the entry lists (the rc-8.5.15.1 manifest
// carries the earlier migrations).
//   setup            files (or { name, sql }) applied first — shims / prerequisites
//   pretest          read-only prerequisite fixture; must leave no trace
//   apply            the migration file(s) under test, in order
//   posttest         assertion fixtures run after apply (must not change the schema)
//   rollback         rollback file(s) (applied in reverse order)
//   rollbackPosttest fixtures run after the rollback
// Paths are repo-relative. Every fixture is linted before anything runs.

const M = (f) => `supabase/migrations/${f}`
export const PROD_SHAPE = 'prod-shape-schema-snapshot'
const SHIM = 'apps/api/tests/pg/supabase-shim.sql'

export const MIGRATION_TESTS = Object.freeze([
  {
    id: 'negotiation_authority',
    setup: [SHIM],
    pretest: M('PROPOSED_20261015190000_negotiation_authority_pretest.sql'),
    apply: [M('PROPOSED_20261015190000_negotiation_authority.sql')],
    posttest: [M('PROPOSED_20261015190000_negotiation_authority_posttest.sql')],
    rollback: [M('PROPOSED_20261015190000_negotiation_authority_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015190000_negotiation_authority_rollback_posttest.sql')],
  },
  {
    id: 'ai_operator_feedback',
    setup: [SHIM],
    pretest: M('PROPOSED_20261015191000_ai_operator_feedback_pretest.sql'),
    apply: [M('PROPOSED_20261015191000_ai_operator_feedback.sql')],
    posttest: [M('PROPOSED_20261015191000_ai_operator_feedback_posttest.sql')],
    rollback: [M('PROPOSED_20261015191000_ai_operator_feedback_rollback.sql')],
    rollbackPosttest: [M('PROPOSED_20261015191000_ai_operator_feedback_rollback_posttest.sql')],
  },
])
