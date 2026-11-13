// The @/ alias (apps/api/src) for the milestone E2E, WITHOUT the critical-test environment (no test seams: the
// automation-hold resolver, sender continuity and the fetch guard stay the production modules).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
register(pathToFileURL(path.join(API, 'tests/alias-loader.mjs')).href, pathToFileURL(`${API}/`))
