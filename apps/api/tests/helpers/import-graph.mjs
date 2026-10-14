// Static transitive import graph over apps/api/src (ESM, "@/" alias, relative specifiers).
// Comments are stripped before scanning; dynamic import("...") with a literal is followed too.
import fs from 'node:fs'
import path from 'node:path'

const API_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(API_ROOT, 'src')
const SPEC_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm

function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function resolveSpec(spec, fromFile) {
  let base
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return { external: spec }
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return { file: cand }
  }
  return { missing: base }
}

/** @returns {{ files: Set<string>, externals: Set<string>, missing: Set<string>, parents: Map<string,string> }} */
export function importClosure(entries) {
  const files = new Set()
  const externals = new Set()
  const missing = new Set()
  const parents = new Map()
  const stack = [...entries]
  while (stack.length) {
    const f = stack.pop()
    if (files.has(f)) continue
    files.add(f)
    const src = strip(fs.readFileSync(f, 'utf8'))
    for (const m of src.matchAll(SPEC_RE)) {
      const spec = m[1] || m[2] || m[3]
      if (!spec) continue
      const r = resolveSpec(spec, f)
      if (r.external) externals.add(r.external)
      else if (r.missing) missing.add(r.missing)
      else if (!files.has(r.file)) { if (!parents.has(r.file)) parents.set(r.file, f); stack.push(r.file) }
    }
  }
  return { files, externals, missing, parents }
}

export function chainTo(target, parents) {
  const out = [target]
  let cur = target
  while (parents.has(cur) && out.length < 40) { cur = parents.get(cur); out.unshift(cur) }
  return out.map((p) => path.relative(SRC, p))
}

export function listFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else if (/\.(m?js)$/.test(e.name)) out.push(p)
  }
  return out
}

export { API_ROOT, SRC }
