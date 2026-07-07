-- Expand inbox filter options allowlist for hydrated columns used by advanced filters.

BEGIN;

CREATE OR REPLACE FUNCTION public.inbox_filter_allowed_column(p_column text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_column = ANY (ARRAY[
    'thread_key','market','city','state','zip','property_type','property_class','owner_type_guess',
    'stage','status','ui_intent','latest_direction','best_language','building_condition','priority_bucket',
    'est_household_income','net_asset_value','occupation_group','gender','marital_status','education_model',
    'occupation','owner_priority_tier','phone_carrier','property_county_name','market_region','units_count',
    'total_bedrooms','total_baths','building_square_feet','year_built','effective_year_built','estimated_value',
    'equity_percent','equity_amount','total_loan_balance','total_loan_amt','total_loan_payment','tax_amt',
    'past_due_amount','estimated_repair_cost','ai_score','final_acquisition_score','deal_strength_score',
    'priority_score','ownership_years','prospect_age','buying_power','contactability_score',
    'financial_pressure_score','urgency_score','owner_priority_score','portfolio_total_value',
    'portfolio_total_equity','portfolio_total_loan_balance','portfolio_total_units','property_count',
    'message_count','inbound_count','outbound_count','pending_queue_count','cash_offer','assd_total_value',
    'calculated_total_value','sale_price','lot_square_feet','lot_acreage','latest_message_at','last_inbound_at',
    'last_outbound_at','sale_date','follow_up_at','owner_display_name','best_phone','seller_phone',
    'property_address_full','event_property_address','is_read','is_starred','is_pinned','is_archived',
    'is_suppressed','property_tax_delinquent','property_active_lien','is_corporate_owner','out_of_state_owner',
    'likely_owner','likely_renting','sms_eligible','email_eligible','prospect_best_email','property_flags_text',
    'property_flags_json','person_flags_text','person_flags_json','inbox_category',
    'latest_delivery_status','automation_status','building_quality','rehab_level','construction_type',
    'style','basement','garage','air_conditioning','heating_type','roof_type','pool','zoning','flood_zone',
    'best_contact_window'
  ]);
$$;

COMMIT;