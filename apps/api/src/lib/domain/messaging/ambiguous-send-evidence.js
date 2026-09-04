/**
 * ambiguous-send-evidence.js
 *
 * ONE PLACE THAT ANSWERS: "might this row already have reached the human?"
 *
 * When a send times out or the connection resets after the request was written,
 * TextGrid may have accepted and delivered the message while we never heard the
 * answer. Such a row is finalized `failed` because it did not complete for US --
 * but from the SELLER's point of view it may be indistinguishable from a
 * delivered message.
 *
 * That distinction matters for de-duplication. Dedupe checks ask "has this
 * person already been contacted?", and they historically answered by looking at
 * `sent`/`delivered` rows only. An ambiguous row is neither, so it did not
 * block a fresh enqueue -- and the fresh row would be a SECOND message to
 * someone who may already have received the first.
 *
 * TextGrid offers no caller idempotency key and no verified message lookup, so
 * this cannot be resolved by querying the provider. Until the §11 attempt
 * ledger and orphan-callback adoption exist, the only safe reading of an
 * ambiguous attempt is "assume the human may have seen it".
 */

const AMBIGUOUS_FAILURE_CLASSES = Object.freeze([
  // Timeout / reset / malformed response after the request may have been written.
  "provider_ambiguous_transport",
  // Provider answered without a message SID: acceptance cannot be excluded.
  "provider_ambiguous_accept",
]);

const AMBIGUOUS_REASONS = Object.freeze([
  "provider_outcome_unknown_after_request",
  "provider_response_missing_sid",
]);

export { AMBIGUOUS_FAILURE_CLASSES, AMBIGUOUS_REASONS };

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * True when a send_queue row's durable evidence says the provider outcome was
 * never established. Reads only persisted fields, so it works on a row fetched
 * long after the attempt.
 */
export function isAmbiguousSendRow(row = {}) {
  if (!row || typeof row !== "object") return false;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const provider_error =
    metadata.provider_error && typeof metadata.provider_error === "object"
      ? metadata.provider_error
      : {};

  const candidates = [
    provider_error.failure_class,
    provider_error.normalized_reason,
    provider_error.non_retryable_reason,
    metadata.failure_class,
    row.failure_class,
  ].map((value) => clean(value));

  if (candidates.some((value) => AMBIGUOUS_FAILURE_CLASSES.includes(value))) return true;
  if (candidates.some((value) => AMBIGUOUS_REASONS.includes(value))) return true;

  // A row that holds a provider SID but never reached a terminal delivery state
  // is NOT ambiguous in this sense -- the provider accepted it and the delivery
  // callback simply has not landed. That is handled by delivery reconciliation,
  // not here.
  return false;
}

/**
 * Did this recipient already have an attempt whose outcome we could not
 * establish? If so, another send to them is not safe to create.
 *
 * Deliberately keyed on the RECIPIENT rather than the campaign target or thread:
 * contacting the same human twice is the harm, whichever logical action
 * initiated it.
 *
 * @param {object} args
 * @param {object} args.supabase
 * @param {string} args.to_phone_number
 * @param {string} [args.since] ISO lower bound on created_at
 * @param {string} [args.transport_fingerprint] narrow to one rendered message
 * @returns {Promise<{found:boolean, row_id:string|null, failure_class:string|null, degraded:boolean}>}
 */
export async function findAmbiguousPriorSend({
  supabase,
  to_phone_number,
  since = null,
  transport_fingerprint = null,
} = {}) {
  const recipient = clean(to_phone_number);
  if (!supabase?.from || !recipient) {
    // No way to check is not a licence to send.
    return { found: false, row_id: null, failure_class: null, degraded: true };
  }

  try {
    let query = supabase
      .from("send_queue")
      .select("id,queue_status,metadata,created_at")
      .eq("to_phone_number", recipient)
      .eq("queue_status", "failed")
      // Deliberately unordered: the question is only whether ANY ambiguous
      // attempt exists, and requiring .order() would add a query capability
      // this predicate does not need.
      .limit(50);

    if (since) query = query.gte("created_at", since);
    if (transport_fingerprint) {
      query = query.contains("metadata", { transport_fingerprint });
    }

    const { data, error } = await query;
    if (error) {
      // A failed lookup must not silently authorise a duplicate.
      return { found: false, row_id: null, failure_class: null, degraded: true };
    }

    const hit = (Array.isArray(data) ? data : []).find((row) => isAmbiguousSendRow(row));
    if (!hit) return { found: false, row_id: null, failure_class: null, degraded: false };

    const metadata = hit.metadata && typeof hit.metadata === "object" ? hit.metadata : {};
    return {
      found: true,
      row_id: hit.id ?? null,
      failure_class: clean(metadata?.provider_error?.failure_class) || null,
      degraded: false,
    };
  } catch {
    return { found: false, row_id: null, failure_class: null, degraded: true };
  }
}

export default isAmbiguousSendRow;
