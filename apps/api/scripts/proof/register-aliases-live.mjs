// Alias resolution for LIVE proof scripts.
//
// tests/register-aliases.mjs also installs helpers/critical-test-environment.mjs,
// whose fetch guard throws CRITICAL_TEST_NETWORK_BLOCKED on any real request —
// correct for the critical suite, fatal for a proof that must talk to
// production. This registers only the `@/` resolver.
//
// Must be run with cwd = apps/api; the alias loader resolves against
// process.cwd()/src.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('../../tests/alias-loader.mjs', pathToFileURL(`${process.cwd()}/scripts/proof/`))
