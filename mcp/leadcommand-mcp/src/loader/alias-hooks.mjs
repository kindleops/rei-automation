// Module resolution hook: `@/…` → apps/api/src/… (the same alias the API and
// its test loader use), so the gateway imports the existing LeadCommand modules
// themselves — not copies.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const API_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../apps/api/src')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) return { url: pathToFileURL(path.join(API_SRC, specifier.slice(2))).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
