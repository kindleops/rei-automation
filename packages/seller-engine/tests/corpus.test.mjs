import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFile, discover, propose, finalize } from '../corpus/manifest.mjs';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'se-corpus-'));
  writeFileSync(join(root, 'properties.csv'), 'property_id,run_id\n1,r1\n2,r1\n');
  writeFileSync(join(root, 'prospects.capture_complete_9756.csv'), 'property_id\n1\n');
  writeFileSync(join(root, 'contact_info.csv.before_elite_enrichment'), 'x\n'); // not .csv → ignored
  mkdirSync(join(root, '_internal'));
  writeFileSync(join(root, '_internal', 'checkpoint_property_ids.txt'), '1\n2\n3\n');
  const clean = mkdtempSync(join(tmpdir(), 'se-corpus-clean-'));
  writeFileSync(join(clean, 'properties.csv'), 'property_id,run_id\n7,r9\n');
  return { root, clean };
}

test('classification: QA-corpus markers quarantined; file sets recognized', () => {
  assert.equal(classifyFile('/x/prospects.capture_complete_9756.csv').qaMarker, true);
  assert.equal(classifyFile('/x/properties.csv').fileSet, 'properties');
  assert.equal(classifyFile('/x/DM_LIST_all_leads.csv').fileSet, null);
});

test('propose: separates vendor_schema_drift_qa_corpus from V1 candidates; records evidence + hashes', async () => {
  const { root, clean } = makeRoot();
  const m = await propose([root, clean], { deep: true });
  const qa = m.corpora.vendor_schema_drift_qa_corpus.files;
  const v1 = m.corpora.corpus_v1_candidates.files;
  assert.ok(qa.some((f) => /capture_complete/.test(f.path)));
  assert.ok(v1.every((f) => !/capture_complete/.test(f.path)));
  assert.ok(v1.every((f) => f.file_sha256 && f.schema_fingerprint && f.row_count >= 1));
  const evidence = m.corpora.vendor_schema_drift_qa_corpus.completion_evidence
    .find((e) => e.root === root);
  assert.equal(evidence.checkpoint_property_ids, 3);
  // schema drift detected between the two properties files (different headers? same here -> 1 fp)
  assert.ok(m.schema_drift.properties.length >= 1);
});

test('finalize refuses without explicit approval AND explicit selection (P2-4)', async () => {
  const { root } = makeRoot();
  const m = await propose([root], { deep: false });
  assert.throws(() => finalize(m, null), /--approve/);
  assert.throws(() => finalize(m, 'corpus_v1'), /no files explicitly selected/);
  m.corpora.corpus_v1_candidates.selection = [m.corpora.corpus_v1_candidates.files[0]?.path ?? 'x'];
  const f = finalize(m, 'corpus_v1');
  assert.equal(f.status, 'approved');
});
