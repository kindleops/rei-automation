#!/usr/bin/env node
/**
 * Writes the PROPOSED eg_property_facts migration, rollback and pretest from the facts registry.
 * Run from apps/api:  node --import ./tests/register-aliases.mjs ../../scripts/entity-graph/generate-eg-property-facts-sql.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
const { generateFactsMigrationSql, generateFactsRollbackSql, generateFactsPretestSql } = await import('@/lib/domain/entity-graph/entity-graph-facts-ddl.js')
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../supabase/migrations')
const files = {
  'PROPOSED_20261009180000_eg_property_facts.sql': generateFactsMigrationSql(),
  'PROPOSED_20261009180000_eg_property_facts_rollback.sql': generateFactsRollbackSql(),
  'PROPOSED_20261009180000_eg_property_facts_pretest.sql': generateFactsPretestSql(),
}
for (const [name, body] of Object.entries(files)) {
  fs.writeFileSync(path.join(dir, name), body)
  console.log(`wrote supabase/migrations/${name} (${body.length} bytes)`)
}
