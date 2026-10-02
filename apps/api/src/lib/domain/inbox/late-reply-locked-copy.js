/**
 * THE LOCKED LATE-REPLY COPY (owner, 2026-10-02, after the rc-7.1 pause).
 *
 * Every one of the 16 re-queued late replies uses one of two rows
 * (scripts/repairs/20261001_late_reply_templates.sql PART 4):
 *   English (English threads AND the wrong-language-from-Spanish threads)
 *     lc-late-checkin-en-1  "This is {{agent_name}}. I reached out a while back
 *                            about {{property_address}}. Just checking back in.
 *                            Are you still the owner?"
 *   Spanish
 *     lc-late-checkin-es-1  "Soy {{agent_name}}. Me comuniqué hace un tiempo por
 *                            {{property_address}}. Solo quería saber si todavía
 *                            eres el propietario."
 * {{agent_name}} is the persona token, {{property_address}} the property token
 * (owner's {{sender}} / {{address}}). Neither greets by name, and neither trips
 * the send-time blank-greeting guard ("Hey," / "Hola,").
 *
 * The earlier per-case lc-late-* rows are left as they are (their history
 * stays attributable); the plan's original template_id is kept on the row as
 * metadata.plan_template_id.
 */
const clean = (v) => String(v ?? "").trim();

export const LOCKED_LATE_REPLY_TEMPLATES = Object.freeze({
  English: "lc-late-checkin-en-1",
  Spanish: "lc-late-checkin-es-1",
});

/** Spanish when the planned row is a Spanish lc-late-* row; English otherwise. */
export function lockedLateReplyLanguage(planTemplateId) {
  return /^lc-late-.*-es-\d+$/.test(clean(planTemplateId)) ? "Spanish" : "English";
}

/**
 * The plan's reply with the locked template, or the reply unchanged when it is
 * not a late-reply row (e.g. the long-cycle row 1124) or has no template.
 */
export function applyLockedLateReplyCopy(reply) {
  const id = clean(reply?.template_id);
  if (!id.startsWith("lc-late-")) return reply;
  return { ...reply, template_id: LOCKED_LATE_REPLY_TEMPLATES[lockedLateReplyLanguage(id)], plan_template_id: id };
}
