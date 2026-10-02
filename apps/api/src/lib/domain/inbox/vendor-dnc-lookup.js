/**
 * VENDOR do_not_call FOR ONE PHONE (seller.owner_phone) — fail closed.
 *
 * DEFECT 2026-10-02: 3 of the cleanup's vendor-DNC holds were
 * vendor_dnc_lookup_unavailable. The old lookup normalised every one of the
 * 1.4M owner_phone values per call:
 *   where right(regexp_replace(phone_value, '\D', '', 'g'), 10) = $1
 * a full scan measured at ~12 s against a 15 s statement_timeout, so under
 * load it timed out and returned null (HOLD). Two of the three were in fact
 * flagged do_not_call; the third was clear.
 *
 * The stored values are 10-digit plaintext (760K), 'Landline Excluded', or
 * ciphertext (is_encrypted, 627K) — no other plaintext format exists — so an
 * exact match on the phone's canonical forms is the same answer at ~1 s.
 *
 * Fail-closed blind spot (also fixed): a phone with NO plaintext row used to
 * read as "not flagged". If the phone's linked individual has ENCRYPTED
 * owner_phone slots, this phone may be one of them, and its flag is unknown:
 * that is now null (HOLD), never false.
 *
 * Returns { dnc: true|false|null, basis }.
 */
const clean = (v) => String(v ?? "").trim();

export function vendorDncPhoneForms(threadKey) {
  const d = clean(threadKey).replace(/\D/g, "");
  const d10 = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (d10.length !== 10) return null;
  return { d10, values: [d10, `1${d10}`, `+1${d10}`], e164: [`+1${d10}`, `1${d10}`, d10] };
}

export const VENDOR_DNC_PLAINTEXT_SQL =
  "select bool_or(do_not_call) as dnc, count(*)::int as n from seller.owner_phone where phone_value = any($1::text[])";

export const VENDOR_DNC_ENCRYPTED_SLOTS_SQL =
  "select count(*) filter (where op.is_encrypted)::int as encrypted_slots, count(*)::int as n " +
  "from public.phones ph " +
  "cross join lateral jsonb_array_elements_text(coalesce(ph.linked_individual_keys_json, '[]'::jsonb)) k(individual_key) " +
  "join seller.owner_phone op on op.individual_key = k.individual_key " +
  "where ph.canonical_e164 = any($1::text[])";

/**
 * @param {(sql: string, params: any[]) => Promise<{rows: object[]}>} query  read-only executor
 */
export async function lookupVendorDnc(query, threadKey) {
  const forms = vendorDncPhoneForms(threadKey);
  if (!forms) return { dnc: null, basis: "unparseable_phone" };
  let plain;
  try {
    plain = await query(VENDOR_DNC_PLAINTEXT_SQL, [forms.values]);
  } catch (error) {
    return { dnc: null, basis: `plaintext_lookup_failed:${clean(error?.code || error?.message).slice(0, 60)}` };
  }
  const p = plain?.rows?.[0] || {};
  if (Number(p.n) > 0) return { dnc: p.dnc === true, basis: "plaintext_match" };
  let enc;
  try {
    enc = await query(VENDOR_DNC_ENCRYPTED_SLOTS_SQL, [forms.e164]);
  } catch (error) {
    return { dnc: null, basis: `encrypted_slot_lookup_failed:${clean(error?.code || error?.message).slice(0, 60)}` };
  }
  const e = enc?.rows?.[0] || {};
  if (Number(e.encrypted_slots) > 0) return { dnc: null, basis: "unverifiable_encrypted_slot" };
  return { dnc: false, basis: Number(e.n) > 0 ? "not_listed_for_linked_individual" : "not_in_vendor_data" };
}

/** Accept the loader's { dnc, basis } or a bare boolean/null. */
export function normalizeVendorDnc(value) {
  if (value && typeof value === "object") {
    return { dnc: value.dnc === true ? true : value.dnc === false ? false : null, basis: value.basis || null };
  }
  return { dnc: value === true ? true : value === false ? false : null, basis: null };
}
