#!/usr/bin/env node
// Importer orchestrator.
//   node importers/run.mjs --dir <exportDir> [--only properties,liens] [--dry-run] [--pilot N] [--resume]
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { importFile } from './common.mjs';
import { mapProperty, mapLien, mapCompany, mapContact, mapProspect } from './mappers.mjs';

const MAPPERS = {
  properties: mapProperty, liens: mapLien, companies: mapCompany,
  contact_info: mapContact, prospects: mapProspect,
};

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    args[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
}
const dir = args.dir;
if (!dir) { console.error('--dir required'); process.exit(1); }
const only = args.only ? String(args.only).split(',') : Object.keys(MAPPERS);

for (const fileSet of only) {
  const filePath = join(dir, `${fileSet}.csv`);
  if (!existsSync(filePath)) { console.log(`skip ${fileSet}: no file`); continue; }
  const res = await importFile({
    filePath, fileSet, mapper: MAPPERS[fileSet],
    dryRun: Boolean(args['dry-run']), resume: Boolean(args.resume),
    pilot: args.pilot ? Number(args.pilot) : null,
  });
  console.log(`${fileSet}: batch=${res.batch.id} rows=${res.batch.row_count} tables=${JSON.stringify(res.tables)} conflicts=${res.conflicts}`);
}
