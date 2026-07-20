// Feature registry: single source of truth is the Phase 2 dictionary +
// readiness matrix (docs/). The engine implements a subset; everything else is
// registered and reported as blocked/not_implemented — visible, never silent.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const P2 = join(ROOT, 'docs', 'seller-engine', 'phase2');

// Phase 4 (engine 1.2.0-provisional): snapshot interface v2 measures the
// renovated-comp spread, cohort value percentiles and repair burden from real
// comp data, so F-052/F-130/F-132 gained code paths (runtime-blocked without a
// v2 snapshot). Three features remain without a code path (data structurally
// absent — rent source, layout norms, buyer exit-mix labels):
export const NOT_IMPLEMENTABLE_YET = new Map([
  ['F-008', 'blocked_by_data: no rent source exists in the corpus'],
  ['F-028', 'blocked_by_comps: cohort layout norms (snapshot v3)'],
  ['F-059', 'blocked_by_buyer_data: exit-mix labels'],
]);
export const IMPLEMENTED = new Set(
  [...Array.from({ length: 62 }, (_, i) => `F-${String(i + 1).padStart(3, '0')}`),
    'F-101', 'F-102', 'F-103', 'F-104', 'F-105', 'F-110', 'F-111', 'F-112', 'F-113',
    'F-120', 'F-121', 'F-122', 'F-123', 'F-124', 'F-125', 'F-126', 'F-127',
    'F-130', 'F-131', 'F-132', 'F-133', 'F-134', 'F-135', 'F-136', 'F-137',
  ].filter((id) => !NOT_IMPLEMENTABLE_YET.has(id)),
);

function parseCsv(text) {
  // minimal RFC4180 for the docs CSVs (no streaming needed)
  const rows = []; let field = ''; let row = []; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

export function loadRegistry() {
  const dict = parseCsv(readFileSync(join(P2, 'SELLER_FEATURE_DICTIONARY_V2.csv'), 'utf8'));
  const ready = parseCsv(readFileSync(join(P2, 'SELLER_DATA_READINESS_MATRIX.csv'), 'utf8'));
  const readiness = new Map(ready.map((r) => [r.feature_id, r.readiness]));
  return dict.map((d) => ({
    feature_id: d.feature_id, family: d.family, feature_name: d.feature_name,
    role: d.role, readiness: readiness.get(d.feature_id) ?? 'unknown',
    implementation: IMPLEMENTED.has(d.feature_id) ? 'implemented' : 'blocked',
    block_reason: NOT_IMPLEMENTABLE_YET.get(d.feature_id) ?? null,
  }));
}
