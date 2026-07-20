// seller_engine_deterministic_v1 — transparent deterministic challenger.
// All weights are provisional_domain_weight (see config); versioned by config
// hash. Explanations are derived from the ACTUAL family components that
// entered the composition — never from a parallel echo of the config — so a
// claimed contribution is always a real one.
import { computeFamilies, loadV1Config } from './families.mjs';

export { loadV1Config };

// features whose absence materially degrades the decision (kept short on
// purpose: a negative explanation should be actionable, not an inventory)
const MATERIAL_MISSING = ['F-007', 'F-023', 'F-018', 'F-013', 'F-110', 'F-046', 'F-001', 'F-133'];

const NEGATIVE_COMPONENTS = /suppressor|damper|stale|unresolved|haircut|blocked|renter_block|reo_exclusion/;

export function scoreDeterministicV1(features) {
  const { cfg, versionId } = loadV1Config();
  const families = computeFamilies(features, cfg);
  const fm = new Map(features.map((f) => [f.feature_id, f]));
  const explanations = [];

  const MULT_FAMILIES = new Set(['identity_confidence', 'authority_confidence', 'dealability']);
  for (const [fam, r] of Object.entries(families)) {
    if (r.score_state === 'blocked') {
      explanations.push({ direction: 'blocked', component: fam, contribution: null,
        evidence: { reason: r.components[0]?.component ?? 'missing snapshot dependency' } });
      continue;
    }
    if (fam === 'execution_priority') continue;
    for (const c of r.components) {
      if (c.contribution === null || c.contribution === undefined || c.contribution === 0) {
        if (!NEGATIVE_COMPONENTS.test(c.component)) continue;
      }
      explanations.push({
        direction: MULT_FAMILIES.has(fam) ? 'gate'
          : NEGATIVE_COMPONENTS.test(c.component) ? 'negative' : 'positive',
        component: `${fam}.${c.component}`,
        contribution: c.contribution,
        weight_class: cfg.weight_class,
      });
    }
  }
  // composition gates as first-class explanations (multiplicative, IX-16/IX-17)
  for (const c of families.execution_priority.components) {
    if (/multiplier|gate|haircut/.test(c.component)) {
      explanations.push({ direction: c.contribution !== null && c.contribution < 1 ? 'negative' : 'gate',
        component: `composition.${c.component}`, contribution: c.contribution });
    }
  }
  // negative explanations for material missing evidence only
  for (const id of MATERIAL_MISSING) {
    const f = fm.get(id);
    if (f && f.value_state === 'unknown' && f.missing_dependencies.length) {
      explanations.push({ direction: 'negative', component: `missing:${id}`,
        contribution: null, evidence: { missing: f.missing_dependencies } });
    }
  }

  // IX-19 dry-run evaluation (never controls outreach; config-disabled)
  const ix19 = evaluateIx19DryRun(cfg.ix19_escalation, fm, families);

  return {
    engine_version_id: versionId,
    weight_class: cfg.weight_class,
    families,
    execution_priority: families.execution_priority.score,
    route: families.execution_priority.route,
    horizon_days: families.execution_priority.horizon_days,
    explanations,
    ix19_dry_run: ix19,
  };
}

export function evaluateIx19DryRun(cfgIx19, fm, families) {
  if (!cfgIx19) return null;
  const stage = fm.get('F-018')?.value;
  const tax = fm.get('F-023')?.value;
  const eq = fm.get('F-007')?.value;
  const ph = fm.get('F-046')?.value;
  const em = fm.get('F-047')?.value;
  const distress = ['nod', 'nos_nts', 'auction_scheduled'].includes(stage)
    || (tax && tax.delinquent && (tax.years_deep ?? 0) >= 2);
  const equityOk = eq !== null && eq !== undefined && eq >= 30;
  const unreachable = (ph?.compliant_phones ?? 0) === 0 && (em ?? 0) === 0;
  return {
    version: cfgIx19.version, enabled: cfgIx19.enabled, mode: cfgIx19.mode,
    would_escalate: Boolean(distress && equityOk && unreachable),
    evidence: { distress, equityOk, unreachable },
    note: 'dry-run only; disabled from production outreach (P2-7)',
  };
}
