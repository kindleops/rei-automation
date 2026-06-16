/**
 * Deal Dossier Field Metadata Registry
 * Source of truth for hydration, filtering, and sorting.
 */

export const DEAL_DOSSIER_SCHEMA = {
  // --- PROSPECT ---
  'prospect.full_name': { label: 'Full Name', group: 'prospect', type: 'string', source_table: 'prospects', filterable: true, sortable: true },
  'prospect.age': { label: 'Age', group: 'prospect', type: 'number', source_table: 'prospects', filterable: true, sortable: true },
  'prospect.occupation': { label: 'Occupation', group: 'prospect', type: 'string', source_table: 'prospects', filterable: true },
  'prospect.est_household_income': { label: 'HH Income', group: 'prospect', type: 'number', source_table: 'prospects', filterable: true, sortable: true, display_format: 'money' },
  'prospect.net_asset_value': { label: 'Net Assets', group: 'prospect', type: 'number', source_table: 'prospects', filterable: true, sortable: true, display_format: 'money' },
  'prospect.buying_power': { label: 'Buying Power', group: 'prospect', type: 'string', source_table: 'prospects', filterable: true },
  'prospect.motivation_score': { label: 'Motivation', group: 'prospect', type: 'number', source_table: 'v_universal_lead_command', filterable: true, sortable: true },

  // --- PROPERTY ---
  'property.full_address': { label: 'Address', group: 'property', type: 'string', source_table: 'properties', filterable: true },
  'property.market': { label: 'Market', group: 'property', type: 'string', source_table: 'properties', filterable: true },
  'property.property_type': { label: 'Type', group: 'property', type: 'string', source_table: 'properties', filterable: true },
  'property.beds': { label: 'Beds', group: 'property', type: 'number', source_table: 'properties', filterable: true, sortable: true },
  'property.baths': { label: 'Baths', group: 'property', type: 'number', source_table: 'properties', filterable: true, sortable: true },
  'property.sqft': { label: 'Sq Ft', group: 'property', type: 'number', source_table: 'properties', filterable: true, sortable: true },
  'property.year_built': { label: 'Year Built', group: 'property', type: 'number', source_table: 'properties', filterable: true, sortable: true },

  // --- FINANCIAL ---
  'valuation.estimated_value': { label: 'Est. Value', group: 'financial', type: 'number', source_table: 'property_valuation_snapshots', filterable: true, sortable: true, display_format: 'money' },
  'valuation.equity_percent': { label: 'Equity %', group: 'financial', type: 'number', source_table: 'property_valuation_snapshots', filterable: true, sortable: true, display_format: 'percent' },
  'deal_status.offer_price': { label: 'Offer Price', group: 'financial', type: 'number', source_table: 'v_universal_lead_command', filterable: true, sortable: true, display_format: 'money' },

  // --- BUYER ---
  'buyer_match.demand_score': { label: 'Buyer Demand', group: 'buyer', type: 'number', source_table: 'buyer_match_runs', filterable: true, sortable: true },
  'buyer_match.buyer_count': { label: 'Match Count', group: 'buyer', type: 'number', source_table: 'buyer_match_runs', filterable: true, sortable: true },

  // --- ACQUISITION ---
  'acquisition_decision.strategy_label': { label: 'Strategy', group: 'acquisition', type: 'string', source_table: 'property_acquisition_scores', filterable: true },
  'acquisition_decision.acquisition_score': { label: 'Acq. Score', group: 'acquisition', type: 'number', source_table: 'property_acquisition_scores', filterable: true, sortable: true },
}
