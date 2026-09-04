/**
 * outbound-content-guard.js
 *
 * The last content check before a seller message reaches the provider.
 *
 * WHY THIS EXISTS WHEN SANITIZATION ALREADY DOES.
 *   personalize_template.js already rewrites em/en dashes to hyphens, and in
 *   the normal path that is what makes this guard pass. But sanitizing at
 *   RENDER time only protects bodies that went through the renderer. A manual
 *   operator body, a body assembled by a newer code path, or a template that
 *   skipped personalisation all reach the wire unsanitised.
 *
 *   A sanitizer upstream is not a guard at the seam: one silently repairs, the
 *   other refuses. This refuses, so a body that never met the sanitizer cannot
 *   quietly become the first em dash a seller receives.
 */

const EM_DASH = '—';
const EN_DASH = '–';

function clean(value) {
  return String(value ?? '');
}

/**
 * @returns {{ok:true}|{ok:false, reason:string, index:number, sample:string}}
 */
export function assertNoEmDash(body) {
  const text = clean(body);
  const index = text.search(/[–—]/);
  if (index === -1) return { ok: true };

  return {
    ok: false,
    reason: 'outbound_body_contains_em_dash',
    index,
    // Enough context to find it, not the whole seller message in a log line.
    sample: text.slice(Math.max(0, index - 20), index + 20),
  };
}

export { EM_DASH, EN_DASH };
export default assertNoEmDash;
