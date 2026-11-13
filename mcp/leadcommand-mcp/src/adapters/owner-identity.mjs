// The recorded owner of a lead's property: who owns it, as what kind of holder, and where the owner receives mail.
// Owner decision A8 (2026-10-30): the acquisition workforce reads seller and owner information as recorded, with no
// artificial redaction. Phone numbers and email addresses stay withheld everywhere (texts go by thread id and
// LeadCommand resolves the number at send; the per-phone identity is kept by counts, eligibility and ids), and the
// gateway's phone / email masking still runs over every string here.
//
// Source: eg_property_facts, the Entity Graph read model the reader already reads (one row per property): the vendor
// owner record's owner_name / owner_1_name / owner_2_name, owner_type and owner_address_full, as recorded. The holder
// kind is the recorded owner_type and is_corporate_owner, never a guess from the name.
import { prov, missing } from '../provenance.mjs'
import { clean, untrusted, read } from './common.mjs'

export const OWNER_IDENTITY_COLUMNS = 'property_id,owner_name,owner_1_name,owner_2_name,owner_type,is_corporate_owner,out_of_state_owner,owner_address_full,owner_location,source_system,updated_at,refreshed_at'
export const OWNER_IDENTITY_UNTRUSTED = ['result.owner_identity.names[]', 'result.owner_identity.entity_type.recorded', 'result.owner_identity.mailing_address', 'result.owner_identity.mailing_location']
export const CONTACTS_WITHHELD = 'Phone numbers and email addresses are never returned: a text goes by thread id and LeadCommand resolves the number at send.'

export function projectOwnerIdentity(r, now = new Date()) {
  if (!r) return { names: [], entity_type: { recorded: null, corporate: null }, mailing_address: null, mailing_location: null, out_of_state: null, contacts: CONTACTS_WITHHELD, provenance: missing('eg_property_facts', 'no_owner_record') }
  const names = []
  for (const v of [r.owner_name, r.owner_1_name, r.owner_2_name]) {
    const n = untrusted(v, 120)
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n)
  }
  const recorded = Boolean(names.length || r.owner_address_full || r.owner_type)
  return {
    names,
    entity_type: { recorded: untrusted(r.owner_type, 60), corporate: r.is_corporate_owner ?? null },
    mailing_address: untrusted(r.owner_address_full, 200),
    mailing_location: untrusted(r.owner_location, 60),
    out_of_state: r.out_of_state_owner ?? null,
    contacts: CONTACTS_WITHHELD,
    provenance: recorded
      ? prov({ kind: 'fact', source: `eg_property_facts (vendor owner record${clean(r.source_system) ? `, ${clean(r.source_system)}` : ''}: owner_name, owner_1_name, owner_2_name, owner_type, owner_address_full)`, as_of: r.updated_at || r.refreshed_at || null, rule: 'as recorded; holder kind from owner_type / is_corporate_owner, never guessed', now })
      : missing('eg_property_facts', 'no_owner_fields_recorded'),
  }
}

/** One read of the owner fields for a property; a failed read is reported, never a guess. */
export async function readOwnerIdentity(db, propertyId, now) {
  try {
    const { rows } = await read(db.from('eg_property_facts').select(OWNER_IDENTITY_COLUMNS).eq('property_id', propertyId).limit(1), 'eg_property_facts')
    return projectOwnerIdentity(rows[0] || null, now)
  } catch {
    return { ...projectOwnerIdentity(null, now), provenance: missing('eg_property_facts', 'read_failed') }
  }
}
