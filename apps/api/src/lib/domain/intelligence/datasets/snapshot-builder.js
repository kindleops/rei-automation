/**
 * IC8 DATASET SNAPSHOT BUILDER (architecture §7).
 *
 *   spec -> keyset-paged reads through an injected source (paced)
 *        -> exclusions (versioned, counted)
 *        -> features as of the decision time (PIT reader + leakage assertion)
 *        -> outcomes via the labeler (explicit labelNow, so rebuilds agree)
 *        -> NDJSON.gz (one gzip member per page) + manifest
 *
 * Resumable: after every page a checkpoint records the cursor, the byte length
 * of the data file and all counters. A restart truncates the data file to that
 * length and continues from the cursor, so an interrupted build produces the
 * same bytes as an uninterrupted one. Sealed snapshots are immutable: the
 * builder refuses to write over a sealed manifest.
 *
 * PII: rows carry internal ids only. The thread key (the seller's phone) is
 * replaced by a per-dataset salted hash; the salt never leaves the caller
 * (the manifest stores its fingerprint). Message text is never written unless
 * the spec is a conversation_only dataset. A guard rejects any record that
 * still looks like it holds a phone number or an email.
 *
 * Source contract (all injected; async allowed):
 *   readPage({ spec, cursor, limit }) -> { rows, nextCursor }   keyset pagination; statement_timeout is the source's job
 *   subjectOf(row) -> { id, asOf, entity, threadKey?, labelSubject? }
 *   loadFeatureBundle(row) -> bundle for the PIT reader
 *   loadOutcomeReads(row, outcomeDef) -> labeler reads
 *   strataOf?(row) -> { [declared stratum]: value }   evaluation strata only, never features
 */

import path from "node:path";

import { computeFeatureVector } from "../features/pit.js";
import { getOutcomeDefinition } from "../outcomes/taxonomy.js";
import { isPositive, labelOutcome, LABELER_VERSION } from "../outcomes/labeler.js";
import { IC8_DATASET_NAMESPACE, hashObject, saltFingerprint, saltedHash, uuidV5 } from "../util/hash.js";
import { toIso, toMs } from "../util/time.js";
import { createExclusionCounter, evaluateExclusions, EXCLUSIONS_VERSION } from "./exclusions.js";
import {
  appendGzipMember,
  encodeNdjson,
  fileSize,
  hashGzipFile,
  readJsonIfExists,
  removeFile,
  truncateFile,
  writeJsonAtomic,
} from "./ndjson-gz.js";

export const SNAPSHOT_BUILDER_VERSION = "ic8_snapshot_builder@1";

export class DatasetSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatasetSpecError";
    this.code = "DATASET_SPEC";
  }
}
export class DatasetSealedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatasetSealedError";
    this.code = "DATASET_SEALED";
  }
}
export class CheckpointMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckpointMismatchError";
    this.code = "CHECKPOINT_MISMATCH";
  }
}
export class PiiLeakError extends Error {
  constructor(message) {
    super(message);
    this.name = "PiiLeakError";
    this.code = "PII_LEAK";
  }
}

const NAME_RE = /^[a-z][a-z0-9_]{2,80}$/;

/** Validate and canonicalise a dataset spec (its hash identifies the dataset). */
export function normalizeDatasetSpec(spec = {}, { registry } = {}) {
  const problems = [];
  if (!NAME_RE.test(String(spec.name || ""))) problems.push("name must be snake_case (3-81 chars)");
  if (!spec.subjectType) problems.push("subjectType is required");
  const entityType = spec.entityType || (spec.subjectType === "send" ? "send" : null);
  if (!entityType) problems.push("entityType is required for non-send subjects");
  if (!spec.featureSetId) problems.push("featureSetId is required");
  else if (registry && !registry.hasSet(spec.featureSetId)) problems.push(`unknown feature set ${spec.featureSetId}`);
  const outcomes = Array.isArray(spec.outcomes) ? spec.outcomes : [];
  if (!outcomes.length) problems.push("at least one outcome is required");
  for (const o of outcomes) {
    try {
      const def = getOutcomeDefinition(o.key, o.version);
      if (def.subjectType !== spec.subjectType) problems.push(`${def.id} labels ${def.subjectType}, not ${spec.subjectType}`);
    } catch (error) {
      problems.push(error.message);
    }
  }
  if ((spec.exclusionsVersion || EXCLUSIONS_VERSION) !== EXCLUSIONS_VERSION) {
    problems.push(`exclusionsVersion ${spec.exclusionsVersion} is not the code's ${EXCLUSIONS_VERSION}`);
  }
  const labelNowMs = toMs(spec.labelNow);
  if (labelNowMs === null) problems.push("labelNow (the labeling cutoff) is required for reproducibility");
  const fromMs = toMs(spec.asOfWindow?.from);
  const toWindowMs = toMs(spec.asOfWindow?.to);
  if (fromMs === null || toWindowMs === null || fromMs >= toWindowMs) problems.push("asOfWindow {from, to} is required and from < to");
  const pageSize = spec.pageSize ?? 500;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000) problems.push("pageSize must be 1..5000");
  const paceMs = spec.paceMs ?? 250;
  if (!Number.isFinite(paceMs) || paceMs < 0) problems.push("paceMs must be >= 0");
  const strata = Array.isArray(spec.strata) ? spec.strata.map(String) : [];
  if (problems.length) throw new DatasetSpecError(`invalid dataset spec: ${problems.join("; ")}`);
  const primary = spec.primaryOutcome || outcomes[0];
  return {
    name: spec.name,
    description: spec.description || null,
    subjectType: spec.subjectType,
    entityType,
    population: spec.population ?? {},
    asOfWindow: { from: toIso(fromMs), to: toIso(toWindowMs) },
    featureSetId: spec.featureSetId,
    outcomes: outcomes.map((o) => ({ key: o.key, version: o.version })),
    primaryOutcome: { key: primary.key, version: primary.version, horizon: primary.horizon || null },
    exclusionsVersion: EXCLUSIONS_VERSION,
    labelNow: toIso(labelNowMs),
    pageSize,
    paceMs,
    strata,
    conversationText: spec.conversationText === true,
    knownBiases: Array.isArray(spec.knownBiases) ? spec.knownBiases.map(String) : [],
  };
}

export function datasetSpecHash(normalizedSpec) {
  // Pacing changes how fast, never what: excluded from the identity.
  const identity = { ...normalizedSpec };
  delete identity.paceMs;
  return hashObject(identity);
}

const E164_RE = /\+\d{10,15}/;
const NANP_VALUE_RE = /^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/;
const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;

function scanValue(value, where, problems) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (E164_RE.test(value) || NANP_VALUE_RE.test(value.trim())) problems.push(`${where} looks like a phone number`);
    if (EMAIL_RE.test(value)) problems.push(`${where} looks like an email address`);
    return;
  }
  if (Array.isArray(value)) value.forEach((item, i) => scanValue(item, `${where}[${i}]`, problems));
  else if (typeof value === "object") for (const [key, inner] of Object.entries(value)) scanValue(inner, `${where}.${key}`, problems);
}

/** Reject a record that still carries a phone, an email or (outside conversation datasets) message text. */
export function assertNoPii(record, { conversationText = false } = {}) {
  const problems = [];
  scanValue(record.features, "features", problems);
  scanValue(record.strata, "strata", problems);
  scanValue(record.outcomes, "outcomes", problems);
  if (!conversationText && /"(message_body|message_text|rendered_message)"/.test(JSON.stringify(record))) {
    problems.push("message text in a non-conversation dataset");
  }
  if (problems.length) throw new PiiLeakError(`record ${record.row_id}: ${problems.join("; ")}`);
  return true;
}

export function normalizeThreadKeyForHash(threadKey) {
  const digits = String(threadKey ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(threadKey ?? "").trim();
}

function emptyCounts(spec) {
  const outcomeStatus = {};
  for (const o of spec.outcomes) outcomeStatus[`${o.key}@${o.version}`] = { pending: 0, mature: 0, censored: 0, positive: 0 };
  return {
    rows_read: 0,
    rows_written: 0,
    outside_window: 0,
    exclusions: null,
    outcome_status: outcomeStatus,
    feature_missing: {},
    feature_errors: {},
    positive_count: 0,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build (or resume) a dataset snapshot. Returns the manifest when sealed, or
 * { status: "partial", checkpoint } when stopped early by maxPages.
 */
export async function buildDatasetSnapshot(rawSpec, deps = {}) {
  const {
    source,
    registry,
    outDir,
    codeCommit,
    salt,
    rules = {},
    now = () => Date.now(),
    sleep = defaultSleep,
    maxPages = Infinity,
    upload = null,
  } = deps;
  if (!source || typeof source.readPage !== "function") throw new DatasetSpecError("deps.source.readPage is required");
  if (!registry) throw new DatasetSpecError("deps.registry is required");
  if (!outDir) throw new DatasetSpecError("deps.outDir is required");
  if (!codeCommit) throw new DatasetSpecError("deps.codeCommit is required (git rev-parse HEAD)");
  if (!salt || String(salt).length < 16) throw new DatasetSpecError("deps.salt (>= 16 chars, kept secret) is required");

  const spec = normalizeDatasetSpec(rawSpec, { registry });
  const specHash = datasetSpecHash(spec);
  const featureSet = registry.getSet(spec.featureSetId);
  const outcomeDefs = spec.outcomes.map((o) => getOutcomeDefinition(o.key, o.version));
  const primaryDef = getOutcomeDefinition(spec.primaryOutcome.key, spec.primaryOutcome.version);
  const fromMs = toMs(spec.asOfWindow.from);
  const toWindowMs = toMs(spec.asOfWindow.to);
  const saltPrint = saltFingerprint(salt);

  const dataPath = path.join(outDir, `${spec.name}.ndjson.gz`);
  const checkpointPath = path.join(outDir, `${spec.name}.checkpoint.json`);
  const manifestPath = path.join(outDir, `${spec.name}.manifest.json`);

  const existingManifest = readJsonIfExists(manifestPath);
  if (existingManifest && existingManifest.sealed === true) {
    throw new DatasetSealedError(`${manifestPath} is sealed; a sealed snapshot is immutable (build a new name/version)`);
  }

  const startedAtMs = now();
  let checkpoint = readJsonIfExists(checkpointPath);
  let counts;
  let exclusionCounter;
  let cursor = null;
  let pageIndex = 0;
  let resumes = 0;
  if (checkpoint) {
    if (checkpoint.spec_hash !== specHash) throw new CheckpointMismatchError("checkpoint belongs to a different spec");
    if (checkpoint.salt_fingerprint !== saltPrint) throw new CheckpointMismatchError("checkpoint was built with a different salt");
    if (checkpoint.builder_version !== SNAPSHOT_BUILDER_VERSION) throw new CheckpointMismatchError("checkpoint was built by another builder version");
    if (fileSize(dataPath) < checkpoint.bytes_written) {
      throw new CheckpointMismatchError("data file is shorter than the checkpoint records; rebuild from scratch");
    }
    truncateFile(dataPath, checkpoint.bytes_written);
    counts = checkpoint.counts;
    exclusionCounter = createExclusionCounter(counts.exclusions);
    cursor = checkpoint.cursor;
    pageIndex = checkpoint.page_index;
    resumes = (checkpoint.resumes || 0) + 1;
    if (checkpoint.done) cursor = null;
  } else {
    truncateFile(dataPath, 0);
    counts = emptyCounts(spec);
    exclusionCounter = createExclusionCounter();
  }

  const labelNowMs = toMs(spec.labelNow);
  let done = Boolean(checkpoint && checkpoint.done);
  let pagesThisRun = 0;

  while (!done) {
    if (pagesThisRun >= maxPages) {
      return { status: "partial", checkpoint: readJsonIfExists(checkpointPath) };
    }
    const page = await source.readPage({ spec, cursor, limit: spec.pageSize });
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    const records = [];
    for (const row of rows) {
      counts.rows_read += 1;
      const record = await buildRecord(row);
      if (record) records.push(record);
    }
    const bytes = records.length ? appendGzipMember(dataPath, encodeNdjson(records)) : 0;
    counts.rows_written += records.length;
    pageIndex += 1;
    pagesThisRun += 1;
    cursor = page?.nextCursor ?? null;
    done = !cursor || rows.length === 0;
    counts.exclusions = exclusionCounter.toJSON();
    checkpoint = {
      builder_version: SNAPSHOT_BUILDER_VERSION,
      spec_hash: specHash,
      salt_fingerprint: saltPrint,
      cursor,
      done,
      page_index: pageIndex,
      bytes_written: fileSize(dataPath),
      page_bytes: bytes,
      counts,
      resumes,
      started_at: checkpoint?.started_at || toIso(startedAtMs),
      saved_at: toIso(now()),
    };
    writeJsonAtomic(checkpointPath, checkpoint);
    if (!done && spec.paceMs > 0) await sleep(spec.paceMs);
  }

  // ── seal ──
  const hashes = hashGzipFile(dataPath);
  const datasetId = uuidV5(`${spec.name}:${specHash}:${hashes.contentSha256}`, IC8_DATASET_NAMESPACE);
  const knownBiases = [
    ...spec.knownBiases,
    ...featureSet.members
      .map((m) => registry.get(m.key, m.version))
      .flatMap((def) => [def.lineage.as_of, def.lineage.pit_note].filter(Boolean).map((note) => `${def.id}: ${note}`)),
  ];
  const manifest = {
    dataset_id: datasetId,
    name: spec.name,
    spec,
    spec_hash: specHash,
    feature_set_id: featureSet.featureSetId,
    feature_set_hash: featureSet.definitionHash,
    feature_set_contains_tier_r: featureSet.containsTierR,
    outcomes: outcomeDefs.map((def) => ({ id: def.id, definition_hash: def.definitionHash, label_source: def.labelSource })),
    primary_outcome: { id: primaryDef.id, horizon: spec.primaryOutcome.horizon },
    exclusions_version: EXCLUSIONS_VERSION,
    labeler_version: LABELER_VERSION,
    builder_version: SNAPSHOT_BUILDER_VERSION,
    row_count: counts.rows_written,
    positive_count: counts.positive_count,
    counts,
    sha256: hashes.sha256,
    content_sha256: hashes.contentSha256,
    bytes: hashes.bytes,
    uri: `file://${path.resolve(dataPath)}`,
    code_commit: codeCommit,
    built_at: toIso(now()),
    build_stats: { pages: pageIndex, resumes, page_size: spec.pageSize, pace_ms: spec.paceMs, duration_ms: now() - startedAtMs },
    pii: {
      unit: "salted sha256 of the thread key (32 hex); salt kept by the builder's caller",
      salt_fingerprint: saltPrint,
      message_text: spec.conversationText,
      names_phones_emails_addresses: false,
    },
    card: {
      target: primaryDef.id,
      population: spec.population,
      as_of_window: spec.asOfWindow,
      label_cutoff: spec.labelNow,
      exclusions: counts.exclusions,
      known_biases: knownBiases,
    },
    sealed: true,
  };
  if (typeof upload === "function") {
    manifest.uri = await upload({ dataPath, manifest });
  }
  writeJsonAtomic(manifestPath, manifest);
  removeFile(checkpointPath);
  return manifest;

  async function buildRecord(row) {
    const exclusion = evaluateExclusions(row, { subjectType: spec.subjectType });
    exclusionCounter.record(exclusion);
    if (exclusion.drop) return null;
    const subject = await source.subjectOf(row);
    const asOfMs = toMs(subject?.asOf);
    if (asOfMs === null) {
      exclusionCounter.recordDrop("missing_true_event_time");
      return null;
    }
    if (asOfMs < fromMs || asOfMs >= toWindowMs) {
      counts.outside_window += 1;
      return null;
    }
    const bundle = await source.loadFeatureBundle(row);
    const vector = computeFeatureVector({
      registry,
      featureSetId: spec.featureSetId,
      entityType: spec.entityType,
      entity: subject.entity || row,
      asOf: asOfMs,
      bundle,
    });
    for (const key of vector.missing) counts.feature_missing[key] = (counts.feature_missing[key] || 0) + 1;
    for (const error of vector.errors) counts.feature_errors[error.code] = (counts.feature_errors[error.code] || 0) + 1;
    const outcomes = {};
    for (const def of outcomeDefs) {
      const reads = (await source.loadOutcomeReads(row, def)) || {};
      const result = labelOutcome(def, subject.labelSubject || { ...row, id: subject.id }, reads, { now: labelNowMs, rules });
      outcomes[def.id] = {
        status: result.status,
        value: result.value,
        observed_at: result.observed_at,
        censor_reason: result.censor_reason,
      };
      const tally = counts.outcome_status[def.id];
      tally[result.status] += 1;
      if (result.status === "mature" && isPositive(result)) tally.positive += 1;
      if (def.id === primaryDef.id && result.status === "mature" && isPositive(result, spec.primaryOutcome.horizon)) {
        counts.positive_count += 1;
      }
    }
    const strata = {};
    if (spec.strata.length && typeof source.strataOf === "function") {
      const raw = (await source.strataOf(row)) || {};
      for (const key of spec.strata) strata[key] = raw[key] ?? null;
    }
    const record = {
      row_id: `${spec.subjectType}:${subject.id}`,
      subject_type: spec.subjectType,
      subject_id: String(subject.id),
      unit: subject.threadKey ? saltedHash(normalizeThreadKeyForHash(subject.threadKey), salt) : null,
      as_of: vector.as_of,
      max_input_time: vector.max_input_time,
      features: vector.values,
      missing: vector.missing,
      outcomes,
      annotations: exclusion.annotations,
      strata,
    };
    assertNoPii(record, { conversationText: spec.conversationText });
    return record;
  }
}

/** Row for intelligence.dataset_snapshots. */
export function toDatasetSnapshotRow(manifest) {
  return {
    dataset_id: manifest.dataset_id,
    name: manifest.name,
    spec: { ...manifest.spec, spec_hash: manifest.spec_hash, feature_set_hash: manifest.feature_set_hash },
    row_count: manifest.row_count,
    positive_count: manifest.positive_count,
    sha256: manifest.sha256,
    uri: manifest.uri,
    code_commit: manifest.code_commit,
    built_at: manifest.built_at,
    build_stats: { ...manifest.build_stats, counts: manifest.counts, card: manifest.card, content_sha256: manifest.content_sha256 },
    sealed: manifest.sealed === true,
  };
}
