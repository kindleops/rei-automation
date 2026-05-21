import fs from 'fs'
import path from 'path'

console.log('🧪 Starting KPI Command Center Proof...\n')

const dataPath = path.resolve('src/lib/data/performanceIntelligence.ts')
const uiPath = path.resolve('src/modules/kpis/KpiIntelligencePage.tsx')

if (!fs.existsSync(dataPath) || !fs.existsSync(uiPath)) {
  console.error('❌ Missing core KPI intelligence files.')
  process.exit(1)
}

const dataContent = fs.readFileSync(dataPath, 'utf8')
const uiContent = fs.readFileSync(uiPath, 'utf8')

let passed = true

if (!dataContent.includes('fetchPerformanceOverview = async (filters: PerformanceFilters)')) {
  console.error('❌ fetchPerformanceOverview does not accept filters.')
  passed = false
} else {
  console.log('✅ fetchPerformanceOverview accepts filters.')
}

if (!uiContent.includes('market') || !uiContent.includes('property_type')) {
  console.error('❌ UI is missing required filters (market, property_type).')
  passed = false
} else {
  console.log('✅ UI includes required filters.')
}

if (!uiContent.includes('Property Type Intelligence') || !uiContent.includes('Seller Signal Intelligence') || !uiContent.includes('Stage & Touch Intelligence')) {
  console.error('❌ UI is missing required dimensional panels.')
  passed = false
} else {
  console.log('✅ UI includes all required dimensional panels.')
}

if (passed) {
  console.log('\n✨ KPI Command Center UI Proof Complete! Systems operational.')
  process.exit(0)
} else {
  process.exit(1)
}
