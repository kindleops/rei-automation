/**
 * READ-ONLY profile of the Pipeline overview's cold path against the configured
 * database. Times each stage and the size of what the scope query ships.
 *
 *   node --env-file=.env.local --import ./tests/register-aliases.mjs scripts/proof/pipeline-overview-profile.mjs
 */
import { supabase } from '@/lib/supabase/client.js'
import { batchHydrateOpportunityProperties } from '@/lib/domain/opportunity/opportunity-property-hydration.js'
import { getPipelineCommandOverview } from '@/lib/domain/opportunity/pipeline-command-service.js'

const ACTIVE = ['active', 'waiting', 'paused', 'nurture']
const t = () => performance.now()
const ms = (a) => `${Math.round(performance.now() - a)}ms`

let a = t()
const full = await supabase.from('acquisition_opportunities').select('*').in('opportunity_status', ACTIVE).limit(5000)
console.log('scope select(*)          ', ms(a), 'rows', full.data?.length, 'json', Math.round(JSON.stringify(full.data || []).length / 1024), 'KB', full.error?.message || '')

a = t()
const lean = await supabase.from('acquisition_opportunities').select('id, primary_thread_key, primary_property_id, acquisition_stage, opportunity_status').in('opportunity_status', ACTIVE).limit(5000)
console.log('scope select(5 cols)     ', ms(a), 'rows', lean.data?.length, lean.error?.message || '')

a = t()
const hydrated = await batchHydrateOpportunityProperties(supabase, full.data || [])
console.log('hydrate properties       ', ms(a), 'rows', hydrated.length)

a = t()
const overview = await getPipelineCommandOverview({})
console.log('overview (cold, total)   ', ms(a), 'cards', overview.totals?.opportunities)

a = t()
await getPipelineCommandOverview({})
console.log('overview (memo warm)     ', ms(a))
