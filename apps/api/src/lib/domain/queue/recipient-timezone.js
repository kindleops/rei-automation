/**
 * THE RECIPIENT'S ZONE AT SEND TIME (rc-7.1 D10).
 *
 * Owner: "missing timezone must never fall back to Chicago for recipient
 * contact windows. Recipient/property timezone needs to remain authoritative."
 *
 * evaluateContactWindow read `send_queue.timezone` and, when it was blank or
 * unrecognised, silently used America/Chicago — and normalizeSendQueueRow
 * stamped Chicago onto every blank row before it even got there. A Pacific
 * seller then got the 08:00 Central gate: 06:00 local. Production history:
 * 82 sent texts went out on that default, and 841 sent texts carry a stored
 * zone that contradicts their property's own state/ZIP (358 of them in the
 * direction that opens the gate before 08:00 local).
 *
 * Order of authority (the same resolver as the plan-time work, 110f0017 /
 * contact-window-timezone.js):
 *   1. the PROPERTY's geography — state, plus ZIP for split-zone states —
 *      from the row, its candidate snapshot, or the properties table;
 *   2. otherwise the zone recorded on the row (label or IANA), if valid;
 *   3. otherwise UNRESOLVED: the caller holds the send. No zone is assumed.
 */
import { deriveTimezoneFromGeography } from "@/lib/domain/campaigns/contact-window-timezone.js";

const clean = (value) => String(value ?? "").trim();

const LABEL_TO_IANA = {
  eastern: "America/New_York", et: "America/New_York", est: "America/New_York", edt: "America/New_York",
  central: "America/Chicago", ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago",
  mountain: "America/Denver", mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver",
  pacific: "America/Los_Angeles", pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles",
  alaska: "America/Anchorage", hawaii: "Pacific/Honolulu",
};

// Whether a zone name is valid never changes within a process, and building an
// Intl.DateTimeFormat costs ~0.15 ms: a 9K-seller cohort spent ~1.3 s here.
const IANA_VALIDITY = new Map();

function isValidIana(zone) {
  if (!zone || !zone.includes("/")) return false;
  const known = IANA_VALIDITY.get(zone);
  if (known !== undefined) return known;
  let valid;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    valid = true;
  } catch {
    valid = false;
  }
  if (IANA_VALIDITY.size < 1000) IANA_VALIDITY.set(zone, valid);
  return valid;
}

/** A stored zone as IANA, or null. Never a default. */
export function storedTimezoneToIana(value) {
  const raw = clean(value);
  if (!raw) return null;
  const mapped = LABEL_TO_IANA[raw.toLowerCase()];
  if (mapped) return mapped;
  return isValidIana(raw) ? raw : null;
}

const metadataOf = (row) => (row?.metadata && typeof row.metadata === "object" ? row.metadata : {});

/** The property's state/ZIP as carried on the queue row itself. */
export function rowPropertyGeography(row = {}) {
  const metadata = metadataOf(row);
  const snapshot = metadata.candidate_snapshot && typeof metadata.candidate_snapshot === "object" ? metadata.candidate_snapshot : {};
  const first = (...values) => values.map(clean).find(Boolean) || null;
  return {
    state: first(row.property_address_state, metadata.property_address_state, snapshot.property_address_state, snapshot.property_state),
    zip: first(row.property_address_zip, metadata.property_address_zip, snapshot.property_address_zip, snapshot.property_zip),
  };
}

/** Does the row need the properties table to place its recipient? */
export function rowNeedsPropertyGeography(row = {}) {
  const geo = rowPropertyGeography(row);
  if (deriveTimezoneFromGeography(geo.state, geo.zip).confident) return false;
  return Boolean(clean(row.property_id));
}

/**
 * Resolve the recipient's zone for one queue row.
 * @param {object} row  send_queue row (raw or normalized)
 * @param {{ propertyGeography?: {state?: string, zip?: string}|null }} [options]
 * @returns {{ok: true, iana: string, basis: string, stored_iana: string|null, corrected: boolean}
 *          | {ok: false, reason: string, detail: string, stored_iana: null}}
 */
export function resolveRecipientTimezone(row = {}, { propertyGeography = null } = {}) {
  const stored_iana = storedTimezoneToIana(row.timezone);
  const onRow = rowPropertyGeography(row);
  const candidates = [onRow];
  if (propertyGeography) candidates.push({ state: clean(propertyGeography.state) || null, zip: clean(propertyGeography.zip) || null });
  let last_basis = "no_geography";
  for (const geo of candidates) {
    const derived = deriveTimezoneFromGeography(geo.state, geo.zip);
    last_basis = derived.basis;
    if (derived.confident && derived.iana) {
      return {
        ok: true,
        iana: derived.iana,
        basis: geo === onRow ? "property_geography" : "property_record",
        stored_iana,
        corrected: Boolean(stored_iana) && stored_iana !== derived.iana,
      };
    }
  }
  if (stored_iana) {
    return { ok: true, iana: stored_iana, basis: "stored_recipient_timezone", stored_iana, corrected: false };
  }
  return { ok: false, reason: "recipient_timezone_unresolved", detail: last_basis, stored_iana: null };
}

/**
 * The properties table's state/ZIP for a set of property ids (one read).
 * @returns {Promise<Map<string, {state: string|null, zip: string|null}>>}
 */
export async function loadPropertyGeography(supabase, propertyIds = []) {
  const ids = [...new Set(propertyIds.map(clean).filter(Boolean))];
  const out = new Map();
  if (!ids.length || !supabase) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("properties")
      .select("property_id,property_address_state,property_address_zip")
      .in("property_id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const p of data || []) {
      out.set(clean(p.property_id), { state: clean(p.property_address_state) || null, zip: clean(p.property_address_zip) || null });
    }
  }
  return out;
}
