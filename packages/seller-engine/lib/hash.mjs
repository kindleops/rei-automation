import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function sha256File(filePath) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) h.update(chunk);
  return h.digest('hex');
}

// Deterministic entity ids: stable across re-runs (idempotent importers) and
// independent of ingestion order. Namespaced to avoid cross-entity collisions.
export function deterministicId(namespace, ...parts) {
  return `${namespace}_${sha256(parts.map((p) => String(p ?? '')).join('')).slice(0, 24)}`;
}
