/**
 * Alias resolution WITHOUT the critical-test network block.
 *
 * tests/register-aliases.mjs also imports critical-test-environment.mjs, which
 * deliberately refuses any unmocked external fetch so unit tests can never
 * touch production. That guard is correct for tests and wrong for a proof
 * script whose whole purpose is to read the real database.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('../../tests/alias-loader.mjs', import.meta.url)
