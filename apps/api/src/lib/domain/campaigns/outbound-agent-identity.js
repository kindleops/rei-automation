/**
 * Canonical outbound agent identity.
 *
 * THE CONTRACT (derived from production, not chosen here)
 * `master_owners.agent_persona` is the authoritative outbound identity, and
 * `{{agent_name}}` renders its FIRST NAME.
 *
 * This is not an invention. Across all 423 historical sends that carry both
 * fields, `send_queue.agent_name` equals `split_part(agent_persona, ' ', 1)` —
 * 423 of 423, zero exceptions. `lib/sms/personalize_template.js` independently
 * applies `firstNameOnly()` to whatever it is given, which is the same rule
 * arrived at from the other direction.
 *
 * The identity is bound to the OWNER, not to the campaign, the template or the
 * sending number. That is a deliberate property: a seller who is contacted more
 * than once hears from the same person each time. It is measurably not
 * sender-bound — number ••9881 alone has introduced itself as Alejandro,
 * Carlos, Helen, Jake, Michael and Nathan to different owners.
 *
 * The persona is also language-aligned via `master_owners.agent_family`
 * ("Spanish Local" -> Carmen Rivera, Carlos Mendez), so rendering a Spanish
 * body with an English persona does not arise from this source.
 *
 * WHAT THIS REPLACES
 * `derive-context-summary.js` sources agent_name from a PODIO item
 * (`getTextValue(agent_item, "title")`). Podio has been unavailable since early
 * August, so that chain resolves to "" and the merge field renders blank —
 * "Hola Rodolfo,  aqui." This module reads live Supabase instead, and has
 * 2,156/2,161 coverage across ready targets.
 *
 * WHAT THIS IS NOT
 * Not `sms_templates.agent_persona` (99% NULL, and where set it is a tone
 * label — "Investor Direct", "Warm Professional" — not a person).
 * Not `campaigns.agent_persona` (NULL on every campaign).
 * Not `textgrid_numbers.friendly_name` ("LOS ANGELES-#4" is a number label).
 * Not `profiles` (app-auth identity, one row, never referenced by the SMS path).
 *
 * FAIL CLOSED
 * No persona means no identity means no send. There is deliberately no default,
 * no placeholder and no company-name fallback: inventing an identity to make
 * rendering succeed is how a stranger's name ends up in a real seller's phone.
 */

const clean = (value) => String(value ?? "").trim();

export const AGENT_IDENTITY_SOURCE = "master_owners.agent_persona";

export const AGENT_IDENTITY_FAILURE = {
  NO_OWNER: "no_master_owner",
  NO_PERSONA: "no_agent_persona",
  UNUSABLE_PERSONA: "unusable_agent_persona",
};

/**
 * First name only, matching personalize_template.js's firstNameOnly().
 * "Carmen Rivera" -> "Carmen". Collapses internal whitespace so a persona
 * stored as "Carlos  Mendez" cannot yield an empty or padded token.
 */
function firstName(persona) {
  const normalized = clean(persona).replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.split(" ")[0] || "";
}

/**
 * Resolve the outbound identity for a target.
 *
 * Pure and synchronous by design: it takes the already-loaded owner row rather
 * than fetching. That is what lets preflight and send-time call the identical
 * function over the identical row and be unable to disagree.
 *
 * @param {object} masterOwner  a master_owners row (or null)
 * @returns {{ok: boolean, agent_name?: string, persona?: string, source: string, reason?: string}}
 */
export function resolveAgentIdentity(masterOwner) {
  if (!masterOwner || typeof masterOwner !== "object") {
    return { ok: false, source: AGENT_IDENTITY_SOURCE, reason: AGENT_IDENTITY_FAILURE.NO_OWNER };
  }

  const persona = clean(masterOwner.agent_persona);
  if (!persona) {
    return { ok: false, source: AGENT_IDENTITY_SOURCE, reason: AGENT_IDENTITY_FAILURE.NO_PERSONA };
  }

  const name = firstName(persona);
  // A persona of "-" or "..." survives whitespace trimming and would render as
  // "Hola Rodolfo, - aqui." A name has to contain at least one letter — including
  // accented ones, since these personas are language-aligned (Mendez, Rivera).
  if (!name || !/\p{L}/u.test(name)) {
    return {
      ok: false,
      source: AGENT_IDENTITY_SOURCE,
      reason: AGENT_IDENTITY_FAILURE.UNUSABLE_PERSONA,
    };
  }

  return { ok: true, agent_name: name, persona, source: AGENT_IDENTITY_SOURCE };
}

/**
 * Build the complete merge-value map for an outbound campaign message.
 *
 * ONE function, called by BOTH the preflight preview and the queue-row builder.
 * The divergence risk this closes is not hypothetical: if preflight assembled
 * its own values, an operator could approve a body that differs from what
 * actually ships. Sharing the constructor makes "preflight equals send" a
 * structural property rather than a convention two call sites must remember.
 *
 * @param {object} input
 * @param {object} input.target       campaign_targets row
 * @param {object} input.masterOwner  master_owners row
 * @returns {{ok: boolean, values?: object, reason?: string}}
 */
export function buildOutboundMergeValues({ target = {}, masterOwner = null } = {}) {
  const identity = resolveAgentIdentity(masterOwner);
  if (!identity.ok) {
    return { ok: false, reason: identity.reason, source: identity.source };
  }

  const metadata =
    target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
      ? target.metadata
      : {};
  const snapshot =
    metadata.candidate_snapshot && typeof metadata.candidate_snapshot === "object"
      ? metadata.candidate_snapshot
      : {};

  return {
    ok: true,
    source: identity.source,
    values: {
      agent_name: identity.agent_name,
      seller_first_name: clean(snapshot.seller_first_name),
      property_address: clean(target.property_address),
    },
    persona: identity.persona,
  };
}
