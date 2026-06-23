#!/usr/bin/env node
/**
 * Pipeline Card System proof — registry, card slots, AOS gating, reply semantics
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const apiRoot = resolve(root, 'apps/api')
process.chdir(apiRoot)

register(
  pathToFileURL(resolve(apiRoot, 'tests/alias-loader.mjs')).href,
  pathToFileURL(`${apiRoot}/`),
)

const results = []
const pass = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`) }
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`) }

console.log('Pipeline Card System Proof\n')

try {
  const { exportRegistryForClient, PIPELINE_DISPLAY_FIELD_REGISTRY } = await import(
    '../../apps/api/src/lib/domain/opportunity/pipeline-display-field-registry.js'
  )

  const registryPath = resolve(root, 'apps/dashboard/src/domain/pipeline/pipeline-display-field-registry.ts')
  const presetsPath = resolve(root, 'apps/dashboard/src/domain/pipeline/pipeline-card-presets.ts')
  const resolverPath = resolve(root, 'apps/dashboard/src/domain/pipeline/pipeline-card-design.types.ts')
  const cardPath = resolve(root, 'apps/dashboard/src/views/pipeline/components/PipelineConfigurableCard.tsx')
  const designerPath = resolve(root, 'apps/dashboard/src/views/pipeline/components/PipelineCardDesigner.tsx')
  const sortPath = resolve(root, 'apps/dashboard/src/views/pipeline/components/PipelineSortBuilder.tsx')
  const filterPath = resolve(root, 'apps/dashboard/src/views/pipeline/components/PipelineFilterBuilder.tsx')

  for (const [name, p] of [
    ['registry_ts', registryPath],
    ['presets_ts', presetsPath],
    ['resolver_types', resolverPath],
    ['configurable_card', cardPath],
    ['card_designer', designerPath],
    ['sort_builder', sortPath],
    ['filter_builder', filterPath],
  ]) {
    if (existsSync(p)) pass(name)
    else fail(name, 'missing')
  }

  const apiCount = Object.keys(PIPELINE_DISPLAY_FIELD_REGISTRY).length
  if (apiCount >= 35) pass('field_registry_count', String(apiCount))
  else fail('field_registry_count', String(apiCount))

  const registrySrc = readFileSync(registryPath, 'utf8')
  const fieldMatches = registrySrc.match(/def\('/g) ?? []
  if (fieldMatches.length >= 35) pass('dashboard_registry_count', String(fieldMatches.length))
  else fail('dashboard_registry_count', String(fieldMatches.length))

  const presetsSrc = readFileSync(presetsPath, 'utf8')
  if (presetsSrc.includes("metric_1: slot('follow_up_due')") && !presetsSrc.match(/metric_\d: slot\('aos'\)/)) {
    pass('default_card_no_aos')
  } else fail('default_card_no_aos')

  if (presetsSrc.includes("badge_3: slot('reply_attention_state')")) pass('reply_badge_correction')
  else fail('reply_badge_correction')

  const resolverSrc = readFileSync(resolve(root, 'apps/dashboard/src/domain/pipeline/pipeline-field-resolver.ts'), 'utf8')
  if (resolverSrc.includes("'Needs Reply'") && resolverSrc.includes("'Seller Replied'") && !resolverSrc.includes("'Reply'")) {
    pass('reply_semantics')
  } else fail('reply_semantics')

  if (resolverSrc.includes('canShowEngineField') && resolverSrc.includes('OFFER_PLUS_STAGES')) pass('aos_visibility_rule')
  else fail('aos_visibility_rule')

  const cardSrc = readFileSync(cardPath, 'utf8')
  if (cardSrc.includes('layoutTier') && cardSrc.includes("tier === '25'") && cardSrc.includes("tier === '50'")) pass('responsive_card_proof')
  else fail('responsive_card_proof')

  const boardSrc = readFileSync(resolve(root, 'apps/dashboard/src/views/pipeline/PipelineOpportunityBoard.tsx'), 'utf8')
  if (!boardSrc.includes('>Reply<') && !boardSrc.includes('"Reply"')) pass('generic_reply_removed')
  else fail('generic_reply_removed')

  if (boardSrc.includes('PipelineConfigurableCard') && boardSrc.includes('PipelineCardDesigner')) pass('card_slot_integration')
  else fail('card_slot_integration')

  const sortSrc = readFileSync(sortPath, 'utf8')
  if (sortSrc.includes('nulls') && sortSrc.includes('Primary')) pass('sort_builder_proof')
  else fail('sort_builder_proof')

  const filterSrc = readFileSync(filterPath, 'utf8')
  if (filterSrc.includes('is_known') && filterSrc.includes('logic')) pass('filter_builder_proof')
  else fail('filter_builder_proof')

  const viewStateSrc = readFileSync(resolve(root, 'apps/dashboard/src/domain/pipeline/pipeline-view-state.ts'), 'utf8')
  if (viewStateSrc.includes('cardDesignsByGroup') && viewStateSrc.includes('localStorage')) pass('saved_view_proof')
  else fail('saved_view_proof')

  const migrationPath = resolve(root, 'apps/api/supabase/migrations/20260621130000_pipeline_saved_views_card_system.sql')
  if (existsSync(migrationPath)) {
    const mig = readFileSync(migrationPath, 'utf8')
    if (mig.includes('is_system') && mig.includes('preset_hot_leads')) pass('system_presets_locked')
    else fail('system_presets_locked')
  } else fail('system_presets_locked', 'migration missing')

  const serviceSrc = readFileSync(resolve(root, 'apps/api/src/lib/domain/opportunity/opportunity-service.js'), 'utf8')
  if (serviceSrc.includes('applyRegistryFilters') && serviceSrc.includes('applyRegistrySorts') && serviceSrc.includes('batchHydrateOpportunityProperties')) {
    pass('query_performance_proof')
  } else fail('query_performance_proof')

  if (serviceSrc.includes("aos: hasEngineRun ? num(row.aos) : null")) pass('no_engine_on_render')
  else fail('no_engine_on_render')

  const clientExport = exportRegistryForClient()
  if (clientExport.every((f) => f.key && !('supabaseColumn' in f))) pass('no_raw_db_exposure')
  else fail('no_raw_db_exposure')

  const cssPath = resolve(root, 'apps/dashboard/src/views/pipeline/pipeline-view.css')
  const css = readFileSync(cssPath, 'utf8')
  if (css.includes("[data-nexus-theme='light']") && css.includes("[data-nexus-theme='red-ops']")) pass('theme_modes')
  else fail('theme_modes')

} catch (err) {
  fail('proof_execution', err.message)
  console.error(err)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '))
  process.exit(1)
}
console.log('\nPASS')
process.exit(0)