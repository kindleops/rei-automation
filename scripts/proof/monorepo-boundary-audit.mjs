#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/Users/ryankindle/rei-automation'
const REPORT_PATH = path.join(ROOT, 'docs/architecture/dashboard-boundary-violations.md')
const SCAN_DIRS = [
  'apps/dashboard/src',
  'apps/dashboard/api',
  'apps/dashboard/scripts',
  'apps/dashboard/supabase',
]

const CATEGORIES = {
  TRUE_FORBIDDEN_RUNTIME: 'TRUE_FORBIDDEN_RUNTIME',
  GUARDED_LEGACY_ENDPOINT: 'GUARDED_LEGACY_ENDPOINT',
  QUARANTINED_SCRIPT: 'QUARANTINED_SCRIPT',
  READ_ONLY_SELECT: 'READ_ONLY_SELECT',
  DOC_OR_COMMENT: 'DOC_OR_COMMENT',
  TEST_OR_PROOF: 'TEST_OR_PROOF',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
}

const TEXT_EXT_ALLOWLIST = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx',
  '.json', '.sql', '.toml', '.env', '.example', '.txt', '.yml', '.yaml',
  '.md', '.css', '.scss', '.html', '.sh'
])

const SECRET_RULES = [
  { key: 'SUPABASE_SERVICE_ROLE_KEY', regex: /SUPABASE_SERVICE_ROLE_KEY/ },
  { key: 'VITE_*SECRET', regex: /\bVITE_[A-Z0-9_]*SECRET\b/ },
  { key: 'TEXTGRID_AUTH_TOKEN', regex: /TEXTGRID_AUTH_TOKEN/ },
  { key: 'TEXTGRID_ACCOUNT_SID', regex: /TEXTGRID_ACCOUNT_SID/ },
  { key: 'QUEUE_ENGINE_SHARED_SECRET', regex: /QUEUE_ENGINE_SHARED_SECRET/ },
  { key: 'CRON_SECRET', regex: /CRON_SECRET/ },
  { key: 'INTERNAL_API_SECRET', regex: /INTERNAL_API_SECRET/ },
]

const LOGIC_RULES = [
  { key: 'template rendering logic', regex: /(render-template|template[_-]?render|renderTemplate\s*\(|templateData\.render)/i },
  { key: 'classification logic', regex: /(classify\s*\(|classification\s*logic)/i },
  { key: 'TextGrid auth/send logic', regex: /(TEXTGRID_AUTH_TOKEN|TEXTGRID_ACCOUNT_SID|VITE_TEXTGRID_API_KEY|\btextgrid\.send\b|\bsendTextgrid\b|webhooks\/textgrid|\bx-textgrid\b)/i },
]

const SUPABASE_MUTATION_RULES = [
  { key: 'direct .insert(', regex: /\.insert\s*\(/ },
  { key: 'direct .update(', regex: /\.update\s*\(/ },
  { key: 'direct .upsert(', regex: /\.upsert\s*\(/ },
  { key: 'direct .delete(', regex: /\.delete\s*\(/ },
  { key: 'direct .rpc(', regex: /\.rpc\s*\(/ },
]

const PROTECTED_FROM_RULES = [
  { key: "from('send_queue')", table: 'send_queue', regex: /\.from\s*\(\s*['\"]send_queue['\"]\s*\)/ },
  { key: "from('message_events')", table: 'message_events', regex: /\.from\s*\(\s*['\"]message_events['\"]\s*\)/ },
  { key: "from('inbox_thread_state')", table: 'inbox_thread_state', regex: /\.from\s*\(\s*['\"]inbox_thread_state['\"]\s*\)/ },
]

const BOUNDARY_GUARD_REGEX = /NEXUS_ALLOW_BACKEND_MUTATION\s*===\s*['\"]true['\"]|NEXUS_ALLOW_BACKEND_MUTATION=true|requireDashboardMutationGuard\s*\(/
const READ_ONLY_HINT_REGEX = /\.select\s*\(|\.maybeSingle\s*\(|\.single\s*\(|\.limit\s*\(|\.order\s*\(|\.eq\s*\(|\.gte\s*\(|\.lte\s*\(/ 

const isDocFile = (filePath) => {
  const base = path.basename(filePath).toLowerCase()
  return base.endsWith('.md') || filePath.includes('/docs/')
}

const isCommentOnly = (line) => {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('--')
}

const isTestOrProofPath = (relFile) => {
  const low = relFile.toLowerCase()
  return low.includes('/tests/') || low.includes('/test-results/') || low.includes('/proof/') || /\b(test|spec)\b/.test(path.basename(low))
}

const isQuarantinedPath = (relFile) => relFile.startsWith('apps/dashboard/scripts/quarantine/')
const isRuntimePath = (relFile) => relFile.startsWith('apps/dashboard/src/') || relFile.startsWith('apps/dashboard/api/')
const isScriptPath = (relFile) => relFile.startsWith('apps/dashboard/scripts/')
const isLegacyApiPath = (relFile) => relFile.startsWith('apps/dashboard/api/internal/')

const walk = (dirAbs, out = []) => {
  if (!fs.existsSync(dirAbs)) return out
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true })
  for (const e of entries) {
    const abs = path.join(dirAbs, e.name)
    if (e.isDirectory()) {
      walk(abs, out)
      continue
    }
    if (!e.isFile()) continue
    const ext = path.extname(e.name)
    if (TEXT_EXT_ALLOWLIST.has(ext) || e.name === '.env.example') out.push(abs)
  }
  return out
}

const findings = []
const byCategory = new Map(Object.values(CATEGORIES).map((k) => [k, 0]))
let guardedCount = 0
let allowedReadOnlyCount = 0

const addFinding = (f) => {
  findings.push(f)
  byCategory.set(f.category, (byCategory.get(f.category) || 0) + 1)
}

for (const rel of SCAN_DIRS) {
  const absDir = path.join(ROOT, rel)
  const files = walk(absDir)

  for (const file of files) {
    const relFile = path.relative(ROOT, file)
    const content = fs.readFileSync(file, 'utf8')
    const lines = content.split(/\r?\n/)
    const isGuardedFile = BOUNDARY_GUARD_REGEX.test(content)

    if (/getSupabaseClient\(|VITE_SUPABASE_ANON_KEY|VITE_SUPABASE_URL|backendClient\./.test(content)) {
      allowedReadOnlyCount += 1
    }

    // 1) Secret + logic patterns
    const allLineRules = [...SECRET_RULES, ...LOGIC_RULES]
    for (const rule of allLineRules) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!rule.regex.test(line)) continue
        const trimmed = line.trim()

        if (isDocFile(file) || isCommentOnly(line)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.DOC_OR_COMMENT, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (isTestOrProofPath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.TEST_OR_PROOF, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (isQuarantinedPath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.QUARANTINED_SCRIPT, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (isLegacyApiPath(relFile) || (isScriptPath(relFile) && isGuardedFile)) {
          guardedCount += 1
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.GUARDED_LEGACY_ENDPOINT, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (!isRuntimePath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
          continue
        }

        if ((rule.key === 'template rendering logic' || rule.key === 'classification logic') && relFile.startsWith('apps/dashboard/src/')) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
          continue
        }

        addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.TRUE_FORBIDDEN_RUNTIME, snippet: trimmed.slice(0, 180) })
      }
    }

    // 2) Protected table from() + mutation/rpc triage
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      const fromRule = PROTECTED_FROM_RULES.find((r) => r.regex.test(line))
      if (!fromRule) continue

      if (isDocFile(file) || isCommentOnly(line)) {
        addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.DOC_OR_COMMENT, snippet: trimmed.slice(0, 180) })
        continue
      }

      if (isTestOrProofPath(relFile)) {
        addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.TEST_OR_PROOF, snippet: trimmed.slice(0, 180) })
        continue
      }

      if (isQuarantinedPath(relFile)) {
        addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.QUARANTINED_SCRIPT, snippet: trimmed.slice(0, 180) })
        continue
      }

      const window = lines.slice(i, Math.min(i + 16, lines.length)).join('\n')
      const hasMutationNearby = SUPABASE_MUTATION_RULES.some((m) => m.regex.test(window))
      const hasReadOnlyNearby = READ_ONLY_HINT_REGEX.test(window)

        if (isLegacyApiPath(relFile) || (isScriptPath(relFile) && isGuardedFile)) {
          guardedCount += 1
          addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.GUARDED_LEGACY_ENDPOINT, snippet: trimmed.slice(0, 180) })
          continue
        }

      if (!isRuntimePath(relFile)) {
        addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
        continue
      }

        if (hasMutationNearby) {
          addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.TRUE_FORBIDDEN_RUNTIME, snippet: trimmed.slice(0, 180) })
        } else if (hasReadOnlyNearby) {
          addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.READ_ONLY_SELECT, snippet: trimmed.slice(0, 180) })
      } else {
        addFinding({ file: relFile, line: i + 1, rule: fromRule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
      }
    }

    // 3) Mutation lines not tied to protected tables -> often false positives
    for (const rule of SUPABASE_MUTATION_RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!rule.regex.test(line)) continue
        const trimmed = line.trim()

        if (isDocFile(file) || isCommentOnly(line)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.DOC_OR_COMMENT, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (isTestOrProofPath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.TEST_OR_PROOF, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (isQuarantinedPath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.QUARANTINED_SCRIPT, snippet: trimmed.slice(0, 180) })
          continue
        }

        const nearby = lines.slice(Math.max(0, i - 12), Math.min(lines.length, i + 6)).join('\n')
        const touchesProtected = PROTECTED_FROM_RULES.some((r) => r.regex.test(nearby))

        if (isLegacyApiPath(relFile) || (isScriptPath(relFile) && isGuardedFile)) {
          guardedCount += 1
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.GUARDED_LEGACY_ENDPOINT, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (!isRuntimePath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
          continue
        }

        if (touchesProtected) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.TRUE_FORBIDDEN_RUNTIME, snippet: trimmed.slice(0, 180) })
        } else if (rule.key === 'direct .rpc(' && isRuntimePath(relFile) && !isLegacyApiPath(relFile)) {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
        } else {
          addFinding({ file: relFile, line: i + 1, rule: rule.key, category: CATEGORIES.FALSE_POSITIVE, snippet: trimmed.slice(0, 180) })
        }
      }
    }
  }
}

// Deduplicate identical findings (same file/line/rule/category)
const dedup = new Map()
for (const f of findings) {
  const k = `${f.file}:${f.line}:${f.rule}:${f.category}`
  if (!dedup.has(k)) dedup.set(k, f)
}
const finalFindings = [...dedup.values()]

const totals = {
  forbidden: finalFindings.filter((f) => f.category === CATEGORIES.TRUE_FORBIDDEN_RUNTIME).length,
  guarded: finalFindings.filter((f) => f.category === CATEGORIES.GUARDED_LEGACY_ENDPOINT).length,
  allowedReadOnly: finalFindings.filter((f) => f.category === CATEGORIES.READ_ONLY_SELECT).length,
}

const categoryTotals = Object.fromEntries(Object.values(CATEGORIES).map((c) => [c, finalFindings.filter((f) => f.category === c).length]))

const trueForbidden = finalFindings
  .filter((f) => f.category === CATEGORIES.TRUE_FORBIDDEN_RUNTIME)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

const top20 = trueForbidden.slice(0, 20)

const cleanupFiles = [...new Set(trueForbidden.map((f) => f.file))].sort()
const quarantineFiles = [...new Set(finalFindings.filter((f) => f.category === CATEGORIES.QUARANTINED_SCRIPT || f.category === CATEGORIES.GUARDED_LEGACY_ENDPOINT).map((f) => f.file))].sort()

const lines = []
lines.push('# Dashboard Boundary Violations Triage')
lines.push('')
lines.push('Generated by `scripts/proof/monorepo-boundary-audit.mjs`.')
lines.push('')
lines.push('## Totals By Category')
lines.push('')
for (const cat of Object.values(CATEGORIES)) {
  lines.push(`- ${cat}: ${categoryTotals[cat]}`)
}
lines.push('')
lines.push('## Top 20 TRUE_FORBIDDEN_RUNTIME Violations')
lines.push('')
if (top20.length === 0) {
  lines.push('- None')
} else {
  for (const f of top20) {
    lines.push(`- ${f.file}:${f.line} [${f.rule}] ${f.snippet}`)
  }
}
lines.push('')
lines.push('## Files Requiring Cleanup')
lines.push('')
if (cleanupFiles.length === 0) {
  lines.push('- None')
} else {
  for (const file of cleanupFiles) lines.push(`- ${file}`)
}
lines.push('')
lines.push('## Files Safe But Should Remain Quarantined')
lines.push('')
if (quarantineFiles.length === 0) {
  lines.push('- None')
} else {
  for (const file of quarantineFiles) lines.push(`- ${file}`)
}
lines.push('')
lines.push('## Recommended Next Actions')
lines.push('')
lines.push('- Move all TRUE_FORBIDDEN_RUNTIME mutations and privileged logic from dashboard runtime to `apps/api` endpoints.')
lines.push('- Keep guarded legacy scripts behind explicit `NEXUS_ALLOW_BACKEND_MUTATION=true` checks and quarantine paths.')
lines.push('- Remove `VITE_*SECRET` usage from dashboard runtime; use server-side proxy/auth.')
lines.push('- Restrict dashboard to read-only anon Supabase usage and `backendClient` API calls.')
lines.push('- Remove dashboard-owned supabase migration ownership from active runtime workflow (keep for history only until migration cleanup phase).')
lines.push('')

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8')

console.log('Monorepo Boundary Audit')
console.log('=======================')
console.log(`Forbidden count: ${totals.forbidden}`)
console.log(`Guarded count: ${totals.guarded}`)
console.log(`Allowed/read-only count: ${totals.allowedReadOnly}`)
console.log(`Report: ${path.relative(ROOT, REPORT_PATH)}`)

if (totals.forbidden > 0) {
  console.log('\nTop TRUE_FORBIDDEN_RUNTIME violations:')
  for (const f of top20) {
    console.log(`- ${f.file}:${f.line} [${f.rule}] ${f.snippet}`)
  }
  process.exit(1)
}

console.log('\nNo TRUE_FORBIDDEN_RUNTIME violations found.')
