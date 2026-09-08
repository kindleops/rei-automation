/**
 * normalize-email-address.js
 *
 * THE canonical form of a seller email address.
 *
 * Every other email module keys off this. Suppression, duplicate-contact
 * protection, eligibility and the send itself must agree on what "the same
 * address" means, or the system will cheerfully email someone who opted out
 * under a spelling it does not recognise.
 *
 * TWO FORMS, DELIBERATELY DIFFERENT
 *
 *   normalized        What we SEND to, and what suppression is keyed on.
 *                     Conservative: case-folded, display name removed, trailing
 *                     domain dot removed. Nothing else is touched, because
 *                     anything more aggressive risks rewriting an address into
 *                     one that does not exist.
 *
 *   mailbox_identity  What we DEDUPE on. Aggressive, and deliberately lossy:
 *                     plus-tags removed, Gmail dots removed, googlemail folded
 *                     onto gmail. Two addresses with the same mailbox_identity
 *                     reach the same human being.
 *
 *   The asymmetry is the point. Sending must use the address as given, because
 *   a rewritten address may bounce. Deduplication and suppression must use the
 *   folded form, because bob+house@gmail.com and b.ob@gmail.com are one seller
 *   with one inbox, and contacting "both" is contacting one person twice --
 *   or emailing someone who already said stop.
 *
 *   When those two goals conflict, suppression wins. Over-suppressing costs us
 *   one outreach. Under-suppressing costs us a complaint from someone who
 *   already told us to stop.
 *
 * CASE FOLDING THE LOCAL PART.
 *   RFC 5321 says the local part MAY be case-sensitive. In practice no mail
 *   provider a residential seller uses treats it that way, and every list this
 *   platform ingests contains the same address in three casings. Folding is
 *   therefore correct for this domain, and it is stated here rather than
 *   assumed so that the tradeoff is visible to the next reader.
 *
 * THIS MODULE NEVER THROWS AND NEVER GUESSES. An address it cannot parse comes
 * back { ok: false, reason }. It does not repair typos, does not strip stray
 * characters until something parses, and does not fall back to the raw input.
 */

/** Local parts that are never a person. Outreach to these is a complaint waiting to happen. */
const ROLE_LOCAL_PARTS = new Set([
  "abuse", "admin", "administrator", "billing", "compliance", "contact", "devnull",
  "help", "hostmaster", "info", "legal", "mail", "mailer-daemon", "marketing",
  "noc", "noreply", "no-reply", "notifications", "postmaster", "privacy", "root",
  "sales", "security", "spam", "support", "sysadmin", "unsubscribe", "webmaster",
]);

/**
 * Known disposable/throwaway domains. Deliberately a short, explicit list rather
 * than a heuristic: a heuristic that guesses "this looks disposable" will
 * eventually discard a real seller, and a short list that misses a few costs
 * only a bounce we already handle.
 */
const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com", "guerrillamail.com", "mailinator.com", "maildrop.cc",
  "temp-mail.org", "tempmail.com", "throwawaymail.com", "trashmail.com",
  "yopmail.com", "sharklasers.com", "getnada.com", "dispostable.com",
]);

/** Domains whose mailboxes ignore dots in the local part. */
const DOT_INSENSITIVE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Domains that are the same mail system under two names. */
const DOMAIN_ALIASES = new Map([["googlemail.com", "gmail.com"]]);

/**
 * Local part is RFC-shaped without being RFC-exhaustive: quoted local parts and
 * comments are legal and essentially never appear in a residential seller list,
 * so accepting them would widen the parser for no benefit.
 */
const LOCAL_PART_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** RFC 5321 limits. Anything longer is not an address we failed to parse; it is not an address. */
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_ADDRESS_LENGTH = 254;

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Pull the address out of `Display Name <addr>` / `<addr>` / `addr`.
 * Returns null when the shape is ambiguous rather than picking a half.
 */
function extractAngleAddress(value) {
  const open = value.indexOf("<");
  const close = value.lastIndexOf(">");
  if (open === -1 && close === -1) return value;
  if (open === -1 || close === -1 || close < open) return null;
  return value.slice(open + 1, close).trim();
}

function foldLocalPart(local_part, domain) {
  // Plus-tagging is a routing hint, not part of the mailbox. Everything after
  // the first "+" is discarded for identity on every domain that supports it --
  // and on domains that do not, an address containing "+" is vanishingly rare,
  // so folding is safe in the direction that matters.
  const untagged = local_part.split("+", 1)[0];
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) return untagged.replace(/\./g, "");
  return untagged;
}

/**
 * @param {string} input raw address, possibly with a display name
 * @returns {{ok:true, normalized:string, local_part:string, domain:string,
 *            mailbox_identity:string, is_role_account:boolean,
 *            is_disposable_domain:boolean}
 *        | {ok:false, reason:string}}
 */
export function normalizeEmailAddress(input) {
  const raw = clean(input);
  if (!raw) return { ok: false, reason: "missing_email_address" };

  // A value carrying a separator is a LIST, and a list is never one recipient.
  // Silently taking the first entry is how a message reaches the wrong seller.
  if (/[,;]/.test(raw)) return { ok: false, reason: "multiple_addresses_supplied" };

  const angle_extracted = extractAngleAddress(raw);
  if (angle_extracted === null) return { ok: false, reason: "malformed_address_brackets" };

  const candidate = angle_extracted.trim();
  if (!candidate) return { ok: false, reason: "missing_email_address" };
  if (/\s/.test(candidate)) return { ok: false, reason: "whitespace_in_address" };
  if (candidate.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: "address_too_long" };

  const at_index = candidate.lastIndexOf("@");
  if (at_index <= 0 || at_index === candidate.length - 1) {
    return { ok: false, reason: "missing_domain_separator" };
  }
  // A second "@" outside a quoted local part is not a legal address, and this
  // parser does not accept quoted local parts (see LOCAL_PART_PATTERN).
  if (candidate.indexOf("@") !== at_index) return { ok: false, reason: "multiple_at_signs" };

  const local_part_raw = candidate.slice(0, at_index);
  // A trailing dot is a legal absolute FQDN and a mail-domain equality hazard:
  // "example.com." and "example.com" are the same domain and must not become
  // two suppression entries.
  const domain_raw = candidate.slice(at_index + 1).replace(/\.$/, "");

  if (local_part_raw.length > MAX_LOCAL_PART_LENGTH) {
    return { ok: false, reason: "local_part_too_long" };
  }
  if (!LOCAL_PART_PATTERN.test(local_part_raw)) {
    return { ok: false, reason: "invalid_local_part" };
  }

  const labels = domain_raw.split(".");
  if (labels.length < 2) return { ok: false, reason: "domain_missing_tld" };
  if (!labels.every((label) => label.length > 0 && label.length <= 63 && DOMAIN_LABEL_PATTERN.test(label))) {
    return { ok: false, reason: "invalid_domain" };
  }
  // A numeric TLD is never a real mail domain; it is almost always a truncated
  // IP or a mangled column in an import.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return { ok: false, reason: "invalid_domain_tld" };

  const local_part = local_part_raw.toLowerCase();
  const domain = domain_raw.toLowerCase();
  const normalized = `${local_part}@${domain}`;

  const identity_domain = DOMAIN_ALIASES.get(domain) || domain;
  const identity_local = foldLocalPart(local_part, domain);
  // Folding can only ever shorten the local part, and an address whose ENTIRE
  // local part is a plus-tag ("+tag@x.com") folds to nothing. That is not a
  // mailbox, so it is a refusal rather than an identity of "".
  if (!identity_local) return { ok: false, reason: "invalid_local_part" };

  return {
    ok: true,
    normalized,
    local_part,
    domain,
    mailbox_identity: `${identity_local}@${identity_domain}`,
    is_role_account: ROLE_LOCAL_PARTS.has(identity_local),
    is_disposable_domain: DISPOSABLE_DOMAINS.has(identity_domain),
  };
}

/**
 * Convenience for call sites that only need the sendable form, and that treat
 * an unparseable address as absent. Returns null rather than "" so that a
 * caller cannot accidentally pass a falsy-but-string value onward.
 */
export function toNormalizedEmail(input) {
  const result = normalizeEmailAddress(input);
  return result.ok ? result.normalized : null;
}

/**
 * True when two addresses reach the same human inbox. This is the comparison
 * duplicate-contact protection must use; comparing raw strings would treat
 * bob+a@gmail.com and bob@gmail.com as two different sellers.
 */
export function isSameMailbox(left, right) {
  const a = normalizeEmailAddress(left);
  const b = normalizeEmailAddress(right);
  if (!a.ok || !b.ok) return false;
  return a.mailbox_identity === b.mailbox_identity;
}

export const __TESTING__ = Object.freeze({
  ROLE_LOCAL_PARTS,
  DISPOSABLE_DOMAINS,
  DOT_INSENSITIVE_DOMAINS,
  DOMAIN_ALIASES,
});

export default normalizeEmailAddress;
