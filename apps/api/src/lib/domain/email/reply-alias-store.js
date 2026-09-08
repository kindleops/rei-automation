/**
 * reply-alias-store.js
 *
 * GET-OR-CREATE THE ONE ALIAS A CONVERSATION IS ALLOWED TO HAVE.
 *
 * reply-address.js knows what an alias looks like. This file knows which one a
 * conversation already owns, and it is the only place allowed to mint a new one.
 * The split matters: minting is trivial and pure, and everything difficult about
 * aliases is about NOT minting a second one.
 *
 * ── WHY THE DEFAULT IS OFF, AND WHAT TURNING IT ON ASSERTS ──────────────────
 *
 * Putting `r1.<hex>@reply.<domain>` in a Reply-To header is a promise that mail
 * sent to that address will be received. If the MX records for the reply domain
 * are not live, that promise is false and every seller reply hard-bounces --
 * which is the worst failure in this whole phase, because the seller believes
 * they answered, the operator sees silence, and nothing anywhere logs an error.
 *
 * So aliases require BOTH:
 *
 *   EMAIL_REPLY_DOMAIN                        the domain, server-side only
 *   system_control.email_reply_aliases_enabled  an operator's attestation that
 *                                             MX is live and the inbound
 *                                             consumer is deployed and proven
 *
 * The flag is not a duplicate of the env var. The env var says WHERE; the flag
 * is the human statement that the runbook was completed, and it can be pulled in
 * seconds from the operator console if replies start bouncing, without a deploy.
 * This is the code-side half of the phase decision that MX is not cut over until
 * a proven consumer exists on the other side of it.
 *
 * ── WHEN ALIASING IS OFF OR UNAVAILABLE, THE SEND STILL GOES ────────────────
 *
 * The fallback is the sender's own configured reply address -- a real, monitored
 * human mailbox that existed before this phase. So a seller can always reply;
 * what they lose is AUTOMATIC ATTRIBUTION, and their message lands in the
 * unmatched queue for an operator instead of resolving at tier 1.
 *
 * That degrade is reported, never hidden: the dispatch result names which reply
 * path was used and why. Refusing the send instead would be strictly worse --
 * it stops seller outreach over a threading convenience, and the seller's reply
 * was never at risk, only its filing.
 *
 * ── ONE ALIAS PER CONVERSATION IS ENFORCED IN POSTGRES, NOT HERE ────────────
 *
 * Two concurrent sends to the same seller will both find no alias and both try
 * to insert. A partial unique index on the active row makes the loser's insert
 * fail with 23505, and it re-reads the winner's row. Enforcing this in
 * JavaScript instead would work right up until two runner instances existed.
 */

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { getSystemFlag } from "@/lib/system-control.js";
import {
  generateReplyToken,
  buildReplyAddress,
  replyTokenFingerprint,
  REPLY_ADDRESS_POLICY_VERSION,
} from "@/lib/domain/email/reply-address.js";

const logger = child({ module: "domain.email.reply_alias" });

/** The operator attestation that MX is live and the consumer is proven. */
export const REPLY_ALIAS_FLAG_KEY = "email_reply_aliases_enabled";

const TABLE = "email_reply_aliases";

/** Postgres unique-violation. The concurrency case, not an error. */
const UNIQUE_VIOLATION = "23505";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * The conversation anchors an alias is filed under.
 *
 * opportunity_id is the strong link. The owner and property are carried
 * alongside it rather than instead of it, because an alias may legitimately be
 * minted before an opportunity row exists and an alias that cannot be resolved
 * back to a conversation is a bug that looks like data.
 */
function readConversation(raw_input) {
  // `= {}` only defaults an UNDEFINED argument, never a null one. That exact
  // omission has now been a live defect three times in this codebase -- the SMS
  // queue identity resolver, the email one, and the inbound thread resolver --
  // so it is written out longhand here and covered by a hostile-input test.
  const input = raw_input && typeof raw_input === "object" ? raw_input : {};
  return {
    opportunity_id: clean(input.opportunity_id) || null,
    master_owner_id: clean(input.master_owner_id) || null,
    property_id: clean(input.property_id) || null,
    prospect_id: clean(input.prospect_id) || null,
    thread_key: clean(input.thread_key) || null,
    // Evidence recorded on the row, never a gate at resolution time: sellers
    // reply from phones, aliases and assistants' mailboxes all the time.
    expected_from_email: clean(input.expected_from_email) || null,
  };
}

/** Mirrors the CHECK constraint: an alias with no anchor can never be resolved. */
function hasAnchor(conversation) {
  return Boolean(
    conversation.opportunity_id || conversation.master_owner_id || conversation.thread_key
  );
}

function degraded(reason, extra = {}) {
  return {
    ok: false,
    degrade: true,
    reason,
    address: null,
    policy_version: REPLY_ADDRESS_POLICY_VERSION,
    ...extra,
  };
}

/**
 * Resolve the reply address for one outbound email.
 *
 * @returns {{ok:true, address, token, alias_id, created}
 *          |{ok:false, degrade:true, reason}}
 *          `degrade` is always true: there is no failure here that should stop a
 *          send, and saying so in the shape stops a caller inventing one.
 */
export async function resolveConversationReplyAddress(input, deps = {}) {
  const conversation = readConversation(input);
  const supabase = deps.supabase || defaultSupabase;
  const getFlag = deps.getSystemFlag || getSystemFlag;
  const mintToken = deps.generateReplyToken || generateReplyToken;

  const reply_domain = clean(deps.reply_domain ?? process.env.EMAIL_REPLY_DOMAIN);
  if (!reply_domain) return degraded("reply_domain_not_configured");

  // Read the attestation BEFORE touching the database. When it is off there is
  // no question worth asking, and no reason to spend a round trip asking it.
  const enabled = await getFlag(REPLY_ALIAS_FLAG_KEY);
  if (!enabled) return degraded("reply_aliases_not_enabled", { flag_key: REPLY_ALIAS_FLAG_KEY });

  if (!hasAnchor(conversation)) return degraded("conversation_has_no_anchor");
  if (!supabase?.from) return degraded("reply_alias_store_unavailable");

  const found = await findActiveAlias(supabase, conversation);
  if (found.error) return degraded("reply_alias_lookup_failed");
  if (found.row) return addressFor(found.row, reply_domain, { created: false });

  // A DRY RUN MUST NOT MINT. Minting writes a durable row, and a preview that
  // leaves rows behind is not a preview -- it would also mean an operator
  // rehearsing a campaign silently created an alias per seller. So a dry run
  // reads the conversation's existing alias and reports honestly that there is
  // none yet, rather than showing an address that does not exist.
  if (deps.allow_mint === false) return degraded("reply_alias_not_minted_read_only");

  // ── mint ─────────────────────────────────────────────────────────────────
  const token = mintToken();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      token,
      token_version: token.split(".")[0],
      reply_domain,
      ...conversation,
      expected_from_email: clean(conversation.expected_from_email).toLowerCase() || null,
      policy_version: REPLY_ADDRESS_POLICY_VERSION,
    })
    .select("id, token, reply_domain, is_active")
    .maybeSingle();

  if (!error && data) {
    logger.info("reply_alias.minted", {
      alias_id: data.id,
      reply_token: replyTokenFingerprint(data.token),
      opportunity_id: conversation.opportunity_id,
    });
    return addressFor(data, reply_domain, { created: true });
  }

  if (clean(error?.code) === UNIQUE_VIOLATION) {
    // Another sender won the race. Its row is the conversation's alias; ours was
    // never used and is not retried, because "one active alias" is the whole
    // point and a second attempt would only race again.
    const retry = await findActiveAlias(supabase, conversation);
    if (retry.row) return addressFor(retry.row, reply_domain, { created: false, raced: true });
    return degraded("reply_alias_conflict_unresolved");
  }

  logger.error("reply_alias.mint_failed", {
    reason: clean(error?.message),
    opportunity_id: conversation.opportunity_id,
  });
  return degraded("reply_alias_mint_failed");
}

/**
 * The reuse lookup, in the same precedence order as the partial unique indexes
 * that back it: opportunity first, then owner+property.
 *
 * thread_key is NOT a lookup key. One conversation can carry several thread
 * keys -- that is exactly what related_thread_keys exists for -- so looking up
 * by it would happily return an alias belonging to a sibling thread of a
 * DIFFERENT conversation that once shared a key.
 */
async function findActiveAlias(supabase, conversation) {
  const columns = "id, token, reply_domain, is_active, opportunity_id, master_owner_id, property_id";

  if (conversation.opportunity_id) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(columns)
      .eq("opportunity_id", conversation.opportunity_id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      logger.error("reply_alias.lookup_failed", { reason: clean(error.message) });
      return { error: true, row: null };
    }
    if (data) return { error: false, row: data };
  }

  if (conversation.master_owner_id && conversation.property_id) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(columns)
      .eq("master_owner_id", conversation.master_owner_id)
      .eq("property_id", conversation.property_id)
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      logger.error("reply_alias.lookup_failed", { reason: clean(error.message) });
      return { error: true, row: null };
    }
    if (data) return { error: false, row: data };
  }

  return { error: false, row: null };
}

/**
 * Render a stored alias as an address.
 *
 * The alias keeps the domain it was MINTED with. If the reply domain later
 * changes, mail already in seller inboxes still names the old one, so rewriting
 * the stored row to match today's configuration would break exactly the messages
 * the durable-alias design exists to protect. A mismatch is logged and the
 * stored domain wins.
 */
function addressFor(row, configured_domain, extra = {}) {
  if (row?.is_active === false) return degraded("reply_alias_revoked", { alias_id: row.id || null });

  const domain = clean(row?.reply_domain) || configured_domain;
  if (domain !== configured_domain) {
    logger.warn("reply_alias.domain_drift", {
      alias_id: row?.id || null, stored: domain, configured: configured_domain,
    });
  }

  const built = buildReplyAddress({ token: row?.token, reply_domain: domain });
  if (!built.ok) {
    // A stored row that will not render is a data defect, not a send failure.
    logger.error("reply_alias.unrenderable", { alias_id: row?.id || null, reason: built.reason });
    return degraded("reply_alias_unrenderable", { alias_id: row?.id || null });
  }

  return {
    ok: true,
    degrade: false,
    address: built.address,
    token: built.token,
    alias_id: row.id || null,
    policy_version: REPLY_ADDRESS_POLICY_VERSION,
    ...extra,
  };
}

export default resolveConversationReplyAddress;
