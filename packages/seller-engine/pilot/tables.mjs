// Canonical table specs for the pilot loader: DDL column -> type class, plus
// how to derive the value from a staged row. Types drive guarded casts in the
// merge step; failed casts are counted in pilot_load_rejects, never silently
// coerced. `raw: true` columns receive the full staged row as jsonb (the DDL's
// raw-not-null law); `from` renames staged fields onto DDL columns.
export const T = { text: 'text', int: 'int', num: 'num', bool: 'bool', date: 'date', ts: 'ts', jsonb: 'jsonb', arr: 'arr', float: 'num' };

export const TABLES = {
  import_batches: {
    pk: 'id',
    cols: {
      id: T.text, vendor: T.text, file_set: T.text, source_path: T.text,
      run_ids: T.arr, scraped_at_min: T.ts, scraped_at_max: T.ts,
      file_sha256: T.text, row_count: T.int, schema_fingerprint: T.text,
    },
  },
  source_records: {
    pk: 'id',
    cols: {
      id: T.text, import_batch_id: T.text, source_table: T.text, source_row_number: T.int,
      property_data_id: T.text, payload: T.jsonb, payload_sha256: T.text, scraped_at: T.ts,
    },
    immutable: true,   // append-only lineage: re-merge is a no-op (DO NOTHING), never a payload rewrite
  },
  properties: {
    pk: 'id',
    cols: {
      id: T.text, vendor_property_id: T.text, apn_parcel_id: T.text, fips: T.text,
      situs_address_full: T.text, situs_state: T.text, situs_zip: T.text, situs_county: T.text,
      latitude: T.num, longitude: T.num, asset_class: T.text,
      property_use_standardized: T.text, property_use_raw: T.text,
      year_built: T.int, effective_year_built: T.int,
      building_square_feet: T.num, lot_square_feet: T.num, units_count: T.int,
      condition_raw: T.text, condition_state: T.text, quality_raw: T.text,
      raw: T.jsonb, first_seen_batch: T.text, last_seen_batch: T.text,
    },
    raw: true,
    derive: (r) => ({ first_seen_batch: r.import_batch_id, last_seen_batch: r.import_batch_id }),
    onConflictKeep: ['first_seen_batch'],
  },
  property_valuation_tax_snapshots: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, as_of: T.ts,
      estimated_value: T.num, estimated_equity: T.num,
      equity_percent: T.num, equity_percent_state: T.text,
      tax_amount: T.num, tax_delinquent: T.bool, tax_delinquent_year: T.int,
      import_batch_id: T.text,
    },
  },
  property_ownerships: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, owner_slot: T.int, owner_name_raw: T.text,
      owner_hash: T.text, mailing_address_full: T.text, mailing_state: T.text,
      vesting_raw: T.text, occupancy_raw: T.text, effective_batch: T.text, raw: T.jsonb,
    },
    raw: true,
    derive: (r) => ({ effective_batch: r.import_batch_id }),
  },
  ownership_classifications: {
    pk: 'id',
    cols: {
      id: T.text, ownership_id: T.text, classification: T.text, evidence_source: T.text,
      confidence: T.text, effective_at: T.ts, import_batch_id: T.text,
    },
    notNullDefaults: { effective_at: 'now()' },
  },
  people: {
    pk: 'id',
    cols: {
      id: T.text, individual_key: T.text, identity_tier: T.text, full_name: T.text,
      given_name: T.text, surname: T.text, generational_suffix: T.text,
      household_id: T.text, raw: T.jsonb,
    },
    raw: true,
    nullFillUpdate: true,   // contact_info + prospects both emit people; fill nulls, never blank
  },
  property_person_links: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, person_id: T.text, matching_type: T.text,
      matching_flags: T.arr, likely_owner_scalar: T.bool, is_matching_property_as_owner: T.bool,
      renter_flag: T.bool, link_tier: T.text, scalar_corroborated: T.bool,
      import_batch_id: T.text, raw: T.jsonb,
    },
    raw: true,
    notNullDefaults: { renter_flag: 'false', scalar_corroborated: 'false' },
    fkGuards: { property_id: 'properties', person_id: 'people' },
  },
  contact_phones: {
    pk: 'id',
    cols: {
      id: T.text, person_id: T.text, phone_e164: T.text, phone_raw: T.text, rank: T.int,
      line_type: T.text, carrier_raw: T.text, do_not_call: T.bool, never_call: T.bool,
      import_batch_id: T.text,
    },
  },
  contact_emails: {
    pk: 'id',
    cols: {
      id: T.text, person_id: T.text, email_normalized: T.text, email_raw: T.text, rank: T.int,
      blocked: T.bool, linkage_score: T.num, import_batch_id: T.text,
    },
  },
  companies: {
    pk: 'id',
    cols: {
      id: T.text, jurisdiction_code: T.text, company_number: T.text, company_name: T.text,
      status_raw: T.text, existence_norm: T.text, incorporation_date: T.date,
      dissolution_date: T.date, raw: T.jsonb,
    },
    raw: true,
  },
  property_company_links: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, company_id: T.text, matched_party: T.text,
      matching_type_code: T.text, raw: T.jsonb,
    },
    raw: true,
    fkGuards: { property_id: 'properties', company_id: 'companies' },
  },
  property_loans: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, slot_class: T.text, slot_ordinal: T.int,
      lien_position: T.int, original_loan_amount: T.num,
      estimated_balance: T.num, estimated_balance_state: T.text,
      estimated_interest_rate: T.num, interest_rate_state: T.text,
      term_months: T.int, term_state: T.text, recording_date: T.date, due_date: T.date,
      loan_type_raw: T.text, financing_type_raw: T.text, lender_name: T.text,
      blanket_loan_flag: T.bool, raw: T.jsonb, import_batch_id: T.text,
    },
    raw: true,
    notNullDefaults: { blanket_loan_flag: 'false' },
  },
  loan_checksums: {
    pk: 'property_id',
    cols: {
      property_id: T.text, total_loan_amount: T.num, total_loan_balance: T.num,
      total_loan_payment: T.num, num_of_mortgages: T.int, total_open_lien_nbr: T.int,
      owner_has_multiple_properties: T.bool, conflict_flags: T.arr, import_batch_id: T.text,
    },
  },
  property_transactions: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, vendor_transaction_id: T.text, event_role: T.text,
      sale_date: T.date, sale_price: T.num, price_qualifier_raw: T.text,
      price_qualifier_class: T.text, document_type_raw: T.text, document_type_group: T.text,
      raw: T.jsonb, import_batch_id: T.text,
    },
    raw: true,
  },
  property_liens: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, doc_number: T.text, recording_date: T.date,
      filing_date: T.date, lien_type_raw: T.text, doc_category_code: T.text,
      doc_type_raw: T.text, base_type: T.text, action_modifier: T.text,
      lifecycle_class: T.text, amount_due: T.num, previous_amount_due: T.num,
      county: T.text, state: T.text, date_of_death: T.date, date_of_divorce: T.date,
      raw: T.jsonb, import_batch_id: T.text,
    },
    raw: true,
    notNullDefaults: { lifecycle_class: "'ambiguous'" },
    fkGuards: { property_id: 'properties' },
  },
  lien_parties: {
    pk: 'id',
    cols: {
      id: T.text, lien_id: T.text, party_ordinal: T.int, name_ordinal: T.int,
      full_name: T.text, role_raw: T.text, owner_side: T.bool, raw: T.jsonb,
    },
    raw: true,
    fkGuards: { lien_id: 'property_liens' },
  },
  property_foreclosure_events: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, foreclosure_id: T.text, stage: T.text,
      document_type_raw: T.text, default_date: T.date, auction_date: T.date,
      recording_date: T.date, unpaid_balance: T.num, auction_minimum_bid: T.num,
      raw: T.jsonb, import_batch_id: T.text,
    },
    raw: true,
  },
  unmapped_domain_values: {
    pk: 'id',
    cols: {
      id: T.text, domain_key: T.text, raw_value: T.text, first_seen_batch: T.text,
      occurrence_count: T.int, status: T.text,
    },
    notNullDefaults: { occurrence_count: '1', status: "'pending'" },
  },
  seller_engine_versions: {
    pk: 'id',
    cols: { id: T.text, name: T.text, semver: T.text, config_sha256: T.text, weight_class: T.text, notes: T.text },
  },
  seller_feature_snapshots: {
    pk: 'id',
    cols: {
      id: T.text, property_id: T.text, as_of: T.ts, engine_version_id: T.text,
      features: T.jsonb, inputs_max_observed_at: T.ts,
    },
    fkGuards: { property_id: 'properties' }, immutable: true,
  },
  seller_score_snapshots: {
    pk: 'id',
    cols: {
      id: T.text, feature_snapshot_id: T.text, engine_version_id: T.text,
      family: T.text, score: T.num, score_state: T.text, confidence: T.num,
    },
    fkGuards: { feature_snapshot_id: 'seller_feature_snapshots' }, immutable: true,
  },
  seller_score_explanations: {
    pk: 'id',
    cols: {
      id: T.text, score_snapshot_id: T.text, direction: T.text, component: T.text,
      contribution: T.num, evidence: T.jsonb,
    },
    fkGuards: { score_snapshot_id: 'seller_score_snapshots' }, immutable: true,
  },
};

export function stageDDL(table) {
  const spec = TABLES[table];
  const cols = Object.keys(spec.cols).map((c) => `${c} text`).join(', ');
  return `create unlogged table if not exists stage_${table} (_src_ord bigint generated always as identity, ${cols});`;
}

const CAST = {
  text: (c) => `nullif(s.${c}, '')`,
  int: (c) => `case when s.${c} ~ '^-?[0-9]+$' then s.${c}::integer when s.${c} ~ '^-?[0-9]+\\.[0-9]+$' then round(s.${c}::numeric)::integer else null end`,
  num: (c) => `case when s.${c} ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' then s.${c}::numeric else null end`,
  bool: (c) => `case when lower(s.${c}) in ('true','t','1') then true when lower(s.${c}) in ('false','f','0') then false else null end`,
  date: (c) => `case when s.${c} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then substring(s.${c} from 1 for 10)::date else null end`,
  ts: (c) => `case when s.${c} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then s.${c}::timestamptz else null end`,
  jsonb: (c) => `case when s.${c} <> '' then s.${c}::jsonb else null end`,
  arr: (c) => `case when s.${c} <> '' then s.${c}::text[] else '{}'::text[] end`,
};

function fkClause(spec, alias = 'latest') {
  return Object.entries(spec.fkGuards ?? {})
    .map(([c, parent]) => `and exists (select 1 from ${parent} fk where fk.id = ${alias}.${c})`)
    .join(' ');
}

export function mergeSQL(table) {
  const spec = TABLES[table];
  const cols = Object.keys(spec.cols);
  const casts = cols.map((c) => {
    let expr = CAST[spec.cols[c]](c);
    const dflt = spec.notNullDefaults?.[c];
    if (dflt) expr = `coalesce(${expr}, ${dflt})`;
    return `${expr} as ${c}`;
  });
  const updatable = cols.filter((c) => c !== spec.pk && !(spec.onConflictKeep ?? []).includes(c));
  const onConflict = spec.immutable
    ? 'do nothing'
    : `do update set ${(spec.nullFillUpdate
      ? updatable.map((c) => `${c} = coalesce(${table}.${c}, excluded.${c})`)
      : updatable.map((c) => `${c} = excluded.${c}`)).join(', ')}`;
  return `insert into ${table} (${cols.join(',')})
    select ${cols.join(',')} from (
      select distinct on (${spec.pk}) ${casts.join(', ')}
      from stage_${table} s order by ${spec.pk}, _src_ord desc
    ) latest where ${spec.pk} is not null ${fkClause(spec)}
    on conflict (${spec.pk}) ${onConflict};`;
}

// rows dropped by FK guards are ORPHANS: counted, never silently discarded
export function orphanSQL(table) {
  const spec = TABLES[table];
  if (!spec.fkGuards) return null;
  const casts = Object.keys(spec.cols)
    .map((c) => `${CAST[spec.cols[c]](c)} as ${c}`);
  const conds = Object.entries(spec.fkGuards)
    .map(([c, parent]) => `not exists (select 1 from ${parent} fk where fk.id = latest.${c})`)
    .join(' or ');
  return `select count(*) from (
    select distinct on (${spec.pk}) ${casts.join(', ')}
    from stage_${table} s order by ${spec.pk}, _src_ord desc
  ) latest where ${spec.pk} is not null and (${conds});`;
}

export function rejectSQL(table, batchId) {
  const spec = TABLES[table];
  const checks = Object.entries(spec.cols)
    .filter(([, t]) => ['int', 'num', 'date', 'ts', 'bool'].includes(t))
    .map(([c, t]) => `select '${table}' tt, '${c}' cc, count(*) n, (array_agg(distinct s.${c}))[1:5] sample
       from stage_${table} s where s.${c} <> '' and (${CAST[t](c)}) is null having count(*) > 0`);
  if (!checks.length) return null;
  return `insert into pilot_load_rejects (target_table, column_name, reject_count, sample_values, batch_id)
    select tt, cc, n, sample, '${batchId}' from (${checks.join(' union all ')}) q;`;
}
