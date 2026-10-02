/**
 * Owner-approved correction (RC 7.1, 2026-10-01): opportunity 9b690ce3… (thread
 * +12039942149, property 225438557) sits at opportunity_status 'suppressed' —
 * the opt-out status — while the seller has asked for the contract three times
 * (latest 2026-10-01 00:46Z "Send the contract on over"). No suppression-list
 * row and the thread is not suppressed, so it is NOT an opt-out.
 *
 * Writes through updateOpportunity (per-field history rows = audit trail) with
 * workflow fan-out OFF (a correction must not trigger seller-facing workflows).
 * Guarded: only acts while the row is still 'suppressed'. Dry-run unless --apply.
 */
import { supabase } from '@/lib/supabase/client.js'
import { updateOpportunity } from '@/lib/domain/opportunity/opportunity-service.js'

const ID = '9b690ce3-ff88-400b-b56e-69e9bd0055b0'
const apply = process.argv.includes('--apply')
const { data: cur, error } = await supabase.from('acquisition_opportunities').select('id,opportunity_status,acquisition_stage,latest_intent,primary_thread_key,version').eq('id', ID).single()
if (error) throw error
console.log(JSON.stringify({ before: cur }))
if (cur.opportunity_status !== 'suppressed') { console.log('no-op: status is no longer suppressed'); process.exit(0) }
if (!apply) { console.log('DRY RUN — would set opportunity_status suppressed → active with history; re-run with --apply'); process.exit(0) }
const r = await updateOpportunity(ID, {
  opportunity_status: 'active',
  source: 'rc71_owner_approved_correction',
  actor: 'owner-approved:rc-7.1',
  reason: 'Seller requested the contract (2026-09-27, 09-28, 10-01); no opt-out evidence — suppressed status was set in error.',
}, { emitWorkflowEvents: false })
console.log(JSON.stringify({ ok: r.ok, after: { opportunity_status: r.opportunity?.opportunity_status ?? r.opportunity?.opportunityStatus, automation_state: r.opportunity?.automation_state ?? r.opportunity?.automationState } }))
