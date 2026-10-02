/**
 * Owner-approved correction (RC 7.1, 2026-10-01): opportunity e1db7c94… (property
 * 273312064, thread +16122756497). The seller wrote "$110,000", then "$40,000",
 * then "65"; the old extractor scaled the bare "65" to $65,000 (scaled_from_reference)
 * and made it the canonical ask. Restore the last EXPLICIT seller amount, $40,000,
 * and keep "65" as conversation evidence (history entry kept, marked non-canonical).
 *
 * Guarded on the current state (current ask 65000, version) — no-op otherwise.
 * Audit: a history row for the negotiation-state correction + updateOpportunity's
 * own history row for seller_counter. Workflow fan-out OFF. Dry-run unless --apply.
 */
import { supabase } from '@/lib/supabase/client.js'
import { updateOpportunity } from '@/lib/domain/opportunity/opportunity-service.js'

const ID = 'e1db7c94-60ba-4438-af41-80b6b08535b1'
const SOURCE = 'rc71_owner_approved_correction'
const ACTOR = 'owner-approved:rc-7.1'
const apply = process.argv.includes('--apply')

const { data: cur, error } = await supabase.from('acquisition_opportunities').select('id,version,seller_counter,metadata').eq('id', ID).single()
if (error) throw error
const ns = cur.metadata?.negotiation_state
if (!ns || Number(ns.current_asking_price) !== 65000) { console.log('no-op: current ask is no longer 65000'); process.exit(0) }
const hist = Array.isArray(ns.asking_price_history) ? ns.asking_price_history : []
const explicit = [...hist].reverse().find((h) => h && h.scaled_from_reference === false && Number(h.value) > 0)
if (!explicit || Number(explicit.value) !== 40000) { console.log('abort: last explicit amount is not $40,000', explicit); process.exit(1) }

const nextHist = hist.map((h) => (h && h.scaled_from_reference === true && String(h.extracted_text).trim() === '65')
  ? { ...h, canonical: false, rejected_reason: 'ambiguous_price_scale — a bare "65" is not a price in thousands (RC 7.1)', rejected_at: new Date().toISOString() }
  : h)
const nextNs = {
  ...ns,
  current_ask: 40000,
  current_asking_price: 40000,
  asking_price_confidence: explicit.confidence ?? 0.75,
  asking_price_source_message_id: explicit.source_message_id ?? null,
  asking_price_history: nextHist,
}
console.log(JSON.stringify({ before: { current_ask: ns.current_ask, seller_counter: cur.seller_counter, version: cur.version }, after: { current_ask: 40000, seller_counter: 40000 }, explicit_source: explicit.source_message_id }))
if (!apply) { console.log('DRY RUN — re-run with --apply'); process.exit(0) }

const { data: upd, error: e1 } = await supabase.from('acquisition_opportunities')
  .update({ metadata: { ...cur.metadata, negotiation_state: nextNs } })
  .eq('id', ID).eq('version', cur.version).select('id').single()
if (e1 || !upd) throw e1 || new Error('version moved — re-run')
const { error: e2 } = await supabase.from('acquisition_opportunity_history').insert({
  opportunity_id: ID,
  event_type: 'negotiation_state_corrected',
  field_name: 'negotiation_state.current_asking_price',
  previous_value: '65000',
  new_value: '40000',
  reason: 'Ambiguous "65" had been scaled to $65,000; restored the last explicit seller amount ($40,000). "65" kept as non-canonical evidence.',
  actor: ACTOR,
  source: SOURCE,
  idempotency_key: `rc71-ask-restore:${ID}`,
})
if (e2 && e2.code !== '23505') throw e2
const r = await updateOpportunity(ID, { seller_counter: 40000, source: SOURCE, actor: ACTOR, reason: 'Restore last explicit seller amount ($40,000); ambiguous "65" is not a price.' }, { emitWorkflowEvents: false })
console.log(JSON.stringify({ ok: r.ok, seller_counter: r.opportunity?.seller_counter ?? r.opportunity?.sellerCounter }))
