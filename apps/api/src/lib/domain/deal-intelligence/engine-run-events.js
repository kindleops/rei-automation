/**
 * The terminal event of a streamed engine run. Pure.
 *
 * runAcquisitionEngineWithProgress always emits `decision_ready … done`, even
 * when ensurePropertyAcquisitionDecision REPORTED a failure (result.ok false,
 * status engine_failed). The client read that as success: the run "finished",
 * the property stayed unpriced and no reason was shown. A failed run now ends
 * the stream with { ok: false, error } instead.
 */
const clean = (v) => String(v ?? '').trim()

export function terminalEvent(result) {
  if (result?.ok) return { ok: true, stage: 'decision_ready', status: 'done', decision_status: result.decision_status ?? null }
  return { ok: false, error: clean(result?.error) || 'engine_failed', decision_status: result?.decision_status ?? null }
}
