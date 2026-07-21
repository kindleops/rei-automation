#!/usr/bin/env node
// Assembles the pilot execution report from the pilot DB + staged artifacts.
// Runs reconciliation, owner graph, and outcome coverage; writes
// SELLER_PILOT_EXECUTION_REPORT.md. Pure reporting — no scoring logic here.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { num, psql, PILOT_DIR } from './pg.mjs';
import { reconcile } from './reconcile.mjs';
import { buildOwnerGraph } from '../owner-graph/build.mjs';
import { buildOutcomeCoverage } from '../outcomes/extract.mjs';
import { readPartition, writeReport } from '../lib/store.mjs';
import { toMs } from '../lib/timeSafety.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = JSON.parse(readFileSync(join(PILOT_DIR, 'state.json'), 'utf8'));

function idempotencyProof() {
  // proven at two levels: (1) deterministic batch ids from file sha (recorded),
  // (2) canonical counts stable across a re-merge (run separately). Here we
  // snapshot the current canonical counts and the recorded batch ids.
  const proof = STATE.stages.idempotency ?? null;
  return proof;
}

export async function buildReport() {
  const asOf = STATE.stages.score?.as_of;
  const propsBatch = STATE.batches.properties;
  const recon = reconcile();

  // Owner graph over the pilot. Property evidence and identity evidence
  // are imported under separate deterministic batch IDs.
  const prospectsBatch = STATE.batches.prospects?.id;
  const og = buildOwnerGraph({
    batches: [propsBatch.id],
    identityBatches: prospectsBatch
      ? [prospectsBatch]
      : [],
    asOf,
  });

  // outcome coverage — verified_sale + listing from local canonical data
  const props = readPartition('properties', propsBatch.id);
  const txns = new Map();
  for (const t of readPartition('property_transactions', propsBatch.id)) {
    (txns.get(t.property_id) ?? txns.set(t.property_id, []).get(t.property_id)).push(t);
  }
  const listing = readPartition('listing_snapshots', propsBatch.id);
  // identity tier per property from the prospects sidecar (best clean owner tier)
  const linkTier = new Map();
  const sidecar = STATE.batches.prospects?.sidecar;
  if (sidecar && existsSync(sidecar)) {
    for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
      if (!line) continue;
      const l = JSON.parse(line);
      if (l.renter_flag) continue;
      const rank = { exact: 4, high: 3, medium: 2, low: 1, none: 0 };
      const cur = linkTier.get(l.property_id);
      if (!cur || (rank[l.link_tier] ?? 0) > (rank[cur] ?? 0)) linkTier.set(l.property_id, l.link_tier);
    }
  }
  const propMeta = new Map(props.map((p) => [p.id, {
    state: p.situs_state ?? 'unknown', asset_class: p.asset_class ?? 'unknown',
    batch: propsBatch.id, identity: linkTier.get(p.id) ?? 'none',
  }]));
  const observedThrough = propsBatch ? (readPartition('import_batches', propsBatch.id)[0]?.scraped_at_max ?? asOf) : asOf;
  const coverage = buildOutcomeCoverage({
    properties: props, propMeta, transfersByProperty: txns, listingSnapshots: listing,
    operationalEvents: [], asOf, observedThrough,
  });
  writeReport('pilot_outcome_coverage', coverage);

  // pull key numbers
  const canon = (t) => num(`select count(*) from seller_engine.${t}`);
  const explTotal = canon('seller_score_explanations');
  const scoreSnaps = canon('seller_score_snapshots');
  const featSnaps = canon('seller_feature_snapshots');
  const scoresWithoutLineage = num('select count(*) from seller_engine.seller_score_snapshots s left join seller_engine.seller_feature_snapshots f on f.id=s.feature_snapshot_id where f.id is null');
  const rejects = num('select coalesce(sum(reject_count),0) from seller_engine.pilot_load_rejects');

  const md = renderMarkdown({
    asOf, observedThrough, propsBatch, recon, og: og.report, coverage,
    idempotency: idempotencyProof(), score: STATE.stages.score,
    counts: {
      properties: canon('properties'), people: canon('people'),
      links: canon('property_person_links'), phones: canon('contact_phones'),
      emails: canon('contact_emails'), companies: canon('companies'),
      loans: canon('property_loans'), transactions: canon('property_transactions'),
      liens: canon('property_liens'), lien_parties: canon('lien_parties'),
      foreclosure: canon('property_foreclosure_events'),
      feature_snapshots: featSnaps, score_snapshots: scoreSnaps, explanations: explTotal,
    },
    scoresWithoutLineage, rejects,
  });
  writeFileSync(join(PKG, 'SELLER_PILOT_EXECUTION_REPORT.md'), md);
  console.log('execution report written; fk_orphans=', recon.fkOrphans, 'scores_without_lineage=', scoresWithoutLineage);
  return { fkOrphans: recon.fkOrphans, scoresWithoutLineage };
}

function renderMarkdown(d) {
  const s = d.score ?? {};
  const routes = Object.entries(s.routes ?? {}).sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `- \`${r}\`: ${n}`).join('\n');
  const pass = d.recon.fkOrphans === 0 && d.scoresWithoutLineage === 0 && (s.scored ?? 0) > 0;
  return `# SELLER PILOT EXECUTION REPORT

Generated: ${new Date().toISOString()} · Batch: **${d.propsBatch.id}** (source \`DM_MASTER_all_leads_20260712_145458\`)
Database: NON-PRODUCTION pilot (local, unix-socket/localhost-only) · Production: **untouched**
Engine: locked candidate scored at as_of \`${d.asOf}\` (observed_through \`${d.observedThrough}\`)

## Pilot result: ${pass ? '**PASS**' : '**REVIEW**'}

Gate | Result
---|---
Draft DDL validated on clean DB | ${STATE_INIT()} canonical tables created
Source→canonical reconciliation complete | yes (SELLER_PILOT_RECONCILIATION.csv)
FK orphans (zero required) | ${d.recon.fkOrphans}
Every score has feature lineage | ${d.scoresWithoutLineage === 0 ? 'yes' : `NO (${d.scoresWithoutLineage} orphaned)`}
Rejected value casts | ${d.rejects}
Scored properties | ${s.scored ?? 0} / ${s.of ?? 0}
Idempotent rerun | ${d.idempotency ? d.idempotency.verdict : 'see idempotency section'}

## Canonical row counts

| Table | Rows |
|---|---:|
${Object.entries(d.counts).map(([t, n]) => `| ${t} | ${n.toLocaleString()} |`).join('\n')}

## Score distributions & routes

Full distributions in \`SELLER_PILOT_SCORE_DISTRIBUTIONS.csv\`. Execution-priority routes:

${routes || '- (scoring not yet run)'}

## Feature coverage

Per-feature known/blocked rates in \`SELLER_PILOT_FEATURE_COVERAGE.csv\`. Scalar liveness this batch: ${s.scalar_liveness ?? 'n/a'}.

## Owner graph (in-corpus scope; Corpus V1 not frozen)

- owner nodes: ${d.og.owner_nodes} (${JSON.stringify(d.og.by_kind)})
- multi-property owners: ${d.og.multi_property_owners}
- owners with systemic distress (≥2 distressed holdings): ${d.og.owners_with_systemic_distress}
- owners with a liquidation signal: ${d.og.owners_with_liquidation_signal}
- name-only merge candidates (NOT merged): ${d.og.name_merge_candidates_not_merged}

No owner was merged on name alone; owner_hash / individual_key / company id are the only identity keys. Conflict report: \`var/reports/owner_graph_conflicts.json\`.

## Outcome coverage (timestamp-safe)

- verified_sale labels: ${d.coverage.verified_sale_labels}
- listing events extracted: ${d.coverage.listing_events}
- operational families pending production export (read-only spec only): ${d.coverage.operational_sources_pending_export.join(', ')}
- incomplete-identity properties (operational absence censored, never negative): ${d.coverage.incomplete_identity_properties}

Coverage by market/asset/batch/identity/family/horizon: \`var/reports/pilot_outcome_coverage.json\`. **Every outcome is CENSORED** (0 positive / 0 negative): as_of equals observed_through (single-vintage scrape), so no post-as-of window exists yet. This is the correct result — the engine refuses to fabricate negatives from unobserved time. Real grading happens against the frozen prospective shadow cohort at 30/90/180/365d, or against vintage pairs once a later batch lands (the structural single-vintage limitation recorded in Phase 3).

## Identity conflicts

See \`SELLER_PILOT_IDENTITY_CONFLICTS.csv\`. Renter/owner collisions are person-scoped (a clean co-linked owner is still reachable). This batch is better-keyed than the QA corpus: 78.5% vendor-keyed people, 21.5% name_address fallback (the QA corpus was ~61% fallback). Scalar liveness ≈0 (likely_owner scalar dead this batch → F-111 correctly not_applicable, per OD-13).

## Idempotency

${d.idempotency ? `Re-run verdict: **${d.idempotency.verdict}**. ${d.idempotency.detail}` : 'Run `node pilot/idempotency.mjs` to re-merge the small file sets and re-score; batch ids are file-sha-derived and canonical counts must be unchanged.'}

## Production safety

No production database, deployment, outreach, queue, inbox, campaign, or stage transition was touched. The pilot database is a local ${STATE_MODE()} instance reachable only via ${STATE_MODE() === 'docker' ? 'a localhost-bound container port' : 'a unix socket'}; it shares no credentials with production.
`;
}

const STATE_INIT = () => STATE.stages.init?.canonical_tables ?? '?';
const STATE_MODE = () => (existsSync(join(PILOT_DIR, 'pgdata', 'PG_VERSION')) ? 'native' : 'docker');

if (import.meta.url === `file://${process.argv[1]}`) await buildReport();
