#!/usr/bin/env node
// "ONE FILE PER MIGRATION VERSION" scan (rc-8.5.21 final integration, 2026-10-19).
//
// Supabase migration history (supabase_migrations.schema_migrations) keys on the VERSION, the 14-digit
// stamp at the front of the file name (after an optional PROPOSED_ prefix). Two DIFFERENT migrations
// that share one stamp collide on a production apply: the second is recorded as already applied, or
// refused. This scan fails on any such collision in supabase/migrations.
//
// A COMPANION file is not a separate migration. It has the same stamp, and its slug extends a sibling's
// slug with "_<suffix>": <slug>_pretest / _posttest / _rollback / _rollback_posttest / _verify /
// _dryrun / _api_login / _fleet_snapshot …. Those never enter the migration history on their own.
//
// PERMANENT historical collisions (outside the rc-8.5.21 chain; at least one member applied in production)
// are listed in ALLOWLIST with their evidence. An allowlisted stamp that no longer collides is a STALE entry
// and also fails, so the list can only shrink.
//
//   node scripts/db/scan-duplicate-migration-versions.mjs [--json] [--dir <dir>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_DIR = 'supabase/migrations'

// Resolved from VERIFIED production history (Supabase list_migrations, read-only, retrieved 2026-10-20:
// tmp/rc821-cert/prod-migration-history-20261020.md). That history is INCOMPLETE: out-of-band applies
// (intel_runtime, agent_s3_persistence, agent_research_ro, …) are not recorded. So repo / ledger evidence
// of an out-of-band apply also counts, and an APPLIED production migration is never renamed.
//   resolved 2026-10-20 (no longer duplicates):
//     20261007170000  entity_graph_distress_indexes → 20261007170001, the version production RECORDS
//     20261007120000  queue_health_overdue_semantics (later-added, no apply evidence) → 20261007120500
//     20261006150000  price_reality_check_templates → 20261006150200 (VERIFIED unapplied read-only 2026-10-20:
//                     0 sms_templates rows, 0 send_queue references; tmp/prod-readonly-20261020/RESULTS.md);
//                     command_wall_displays (applied out of band 2026-10-11) keeps 150000
// What remains is PERMANENT historical collisions: excluded from every deploy plan, never renamed.
export const ALLOWLIST = Object.freeze({
  '20261010120000': 'agent_s3_persistence: APPLIED out of band (2026-10-11 agent DB apply). inbox_price_gap_gate: APPLIED (owner apply.sh, 2026-10-12; body drift: production carries the 10-10 body, byte-identical to 5b470fa5 (tmp/owner-apply-20261012); the repo file was edited 10-17 in 31f405e3). Verified read-only 2026-10-20 (tmp/prod-readonly-20261020/RESULTS.md): the view columns in_unclear / f_price_gap / in_price_gap and the counts price_gap / unclear exist; the production view does NOT map declined_unverified; dependents v_inbox_bucket_counts, v_inbox_zero_counts. The forward view migration PROPOSED_20261020120000_inbox_bucket_views_declined_unverified carries the 10-17 mapping. Permanent historical collision: never re-apply, never rename. Excluded from every deploy plan.',
  '20261010130000': 'agent_research_ro: APPLIED out of band (2026-10-11 agent DB apply). inbox_pipeline_hygiene_cleanup: APPLIED (updated_by = hygiene_20261010; follow-up intents in production per rc821-integration/followup-reconciliation.md W5). Permanent historical collision: rename neither. Excluded from every deploy plan.',
})

const FILE_RE = /^(?:PROPOSED_)?(\d{14})_([A-Za-z0-9_]+)\.sql$/

/** Parse file names into { version, slug, file }; names without a 14-digit stamp are ignored. */
export function parseMigrationNames(names) {
  const out = []
  for (const file of names) {
    const m = FILE_RE.exec(file)
    if (m) out.push({ version: m[1], slug: m[2], file })
  }
  return out
}

/**
 * Group by version and drop companions. Returns the versions that carry more than one DISTINCT
 * migration: [{ version, migrations: [file…] }].
 */
export function findDuplicateVersions(names) {
  const byVersion = new Map()
  for (const e of parseMigrationNames(names)) {
    if (!byVersion.has(e.version)) byVersion.set(e.version, [])
    byVersion.get(e.version).push(e)
  }
  const dups = []
  for (const [version, entries] of byVersion) {
    const slugs = entries.map((e) => e.slug)
    const primaries = entries.filter((e) => !slugs.some((s) => s !== e.slug && e.slug.startsWith(`${s}_`)))
    if (primaries.length > 1) dups.push({ version, migrations: primaries.map((e) => e.file).sort() })
  }
  return dups.sort((a, b) => a.version.localeCompare(b.version))
}

export function scanDuplicateVersions({ names, allowlist = ALLOWLIST } = {}) {
  const dups = findDuplicateVersions(names)
  const findings = []
  for (const d of dups) {
    if (!Object.hasOwn(allowlist, d.version)) findings.push({ rule: 'duplicate-version', version: d.version, detail: d.migrations.join(', ') })
  }
  const dupVersions = new Set(dups.map((d) => d.version))
  for (const v of Object.keys(allowlist)) {
    if (!dupVersions.has(v)) findings.push({ rule: 'stale-allowlist', version: v, detail: 'no longer a duplicate: remove it from ALLOWLIST' })
  }
  return { checked: parseMigrationNames(names).length, duplicates: dups, findings }
}

export function scanDir(dir = DEFAULT_DIR, opts = {}) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir)
  return scanDuplicateVersions({ names: fs.readdirSync(abs), ...opts })
}

function main(argv) {
  const i = argv.indexOf('--dir')
  const dir = i >= 0 ? argv[i + 1] : DEFAULT_DIR
  const r = scanDir(dir)
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    for (const f of r.findings) console.log(`${dir}: [${f.rule}] ${f.version}: ${f.detail}`)
    console.log(`scan-duplicate-migration-versions: ${r.checked} file(s) in ${dir}, ${r.duplicates.length} duplicate version(s) (${Object.keys(ALLOWLIST).length} allowlisted), ${r.findings.length} finding(s)`)
  }
  return r.findings.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
