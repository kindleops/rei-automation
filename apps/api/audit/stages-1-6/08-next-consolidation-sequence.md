# Stages 1–6 — Next Consolidation Sequence

This pass delivered the **audit foundation + safe net**. The following is the
ordered plan to reach full single-source consolidation and a true "LOCKED"
verdict. Each step is independently shippable and test-gated.

## Step 1 — Re-key the safety policy onto canonical intents (P0)
- `seller-flow-safety-policy.js` currently keys on `asking_price_value`,
  `condition_signal`, `tenant_or_occupancy`, `wrong_person`.
- Re-key to canonical (`asking_price_provided`, `condition_disclosed`,
  `tenant_occupied`, `wrong_number`) OR run all lookups through
  `normalizeCanonicalIntent`. Densify the sparse stage × intent table.
- Gate: diagnostic stage-map output == live decision output for all intents.

## Step 2 — Make the clarifier stage-aware in the template path (P0)
- Replace the single `unclear_clarifier` in `resolve-seller-auto-reply-plan.js`
  with the `safe-fallback.js` stage × uncertainty matrix as the template source.

## Step 3 — Remove the dead modules (P1)
- After confirming zero importers in CI, delete `automation/intentMap.js`,
  `automation/queueAutoReply.js`, `automation/templateSelector.js`,
  `sms/next_action_from_classification.js` (currently `@deprecated`).
- Gate: build + full critical suite green with them removed.

## Step 4 — Persist exception workflows + SLA dashboard (P1)
- Write `exception_workflow` / `exception_sla_deadline` to the inbox row + a
  `seller_exception_queue` table; surface open-count / oldest / SLA-breach on the
  dashboard. Wire `auto_reclassify` to the next-inbound reclassification.

## Step 5 — Identity-specific template variants (P1)
- Build renter / representative / estate-probate variants (backlog §07).

## Step 6 — Context-conditioned yes/no (P1)
- Condition `classify()` on the prior outbound question/use-case so "yes"/"no"
  resolve by context (ownership-yes vs interest-yes vs acceptance-yes).

## Step 7 — Language expansion (P2)
- ES template parity, then PT/IT/FR/DE/VI/PL or bilingual-rep routing.

## Step 8 — Historical production replay (P2)
- Run the canonical classifier/router over an anonymized prod corpus
  (read-only, hashed bodies) and report classification/routing/template coverage,
  false-positive and fallback rates. (Deferred this pass per scope decision.)

## Then — and only then — Stage 7 Disposition
Prerequisites: Steps 1–4 done; 0 missing-coverage sustained on live replay; offer
→ acceptance → contract handoff stable. Stage 7 work (buyer-match handoff,
assignment packet, dispo outreach) starts after that.
