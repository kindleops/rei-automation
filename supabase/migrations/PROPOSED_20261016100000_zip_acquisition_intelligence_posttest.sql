-- lc-fixture: posttest
-- PROPOSED ONLY — POSTTEST for PROPOSED_20261016100000_zip_acquisition_intelligence.sql: labelled
-- priors, no precise local MAO without evidence, learning loop accepts only validated
-- closing-grade outcomes, validated rows immutable, the training view, access.
-- DISPOSABLE DATABASE ONLY (owner boundary 2026-10-15): never run against production.
-- No transaction control, no includes (rows stay in the disposable database).
-- Expected last notice: "posttest(zip_acquisition_intelligence): all assertions OK".
\set ON_ERROR_STOP on

do $$
declare
  o1 uuid;
  o2 uuid;
  n integer;
begin
  -- a ZIP cell on its own evidence, an indicative band shrunk toward the county, a prior-only cell
  insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
    sales_per_month, investor_share, cash_share, investor_discount_vs_retail, investor_discount_vs_retail_own, discount_p25, discount_p75, typical_exit, confidence, window_start, window_end,
    prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
  values ('zip-acq-econ.v1', '75051', 'sfr', 'all', 'all', 400, 60, 80, 260, 50, 70, 33.3, 0.43, 0.5, 0.22, 0.22, 0.15, 0.3, 'investor_cash_resale', 0.9, '2025-10-01', '2026-07-28',
    'zip', 'own_evidence_only', null, 1, 'local', 'market:dallas-tx', now());
  insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
    investor_discount_vs_retail, investor_discount_vs_retail_own, discount_p25, discount_p75, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
  values ('zip-acq-econ.v1', '75052', 'sfr', 'all', 'all', 30, 4, 5, 21, 3, 4, 0.18, 0.1, 0.1, 0.28, 'retail_resale', 0.31, 'county', 'shrunk_toward:county', 'county:TX:dallas', 0.231, 'indicative_band', 'market:dallas-tx', now());
  insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
    investor_discount_vs_retail, discount_p25, discount_p75, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
  values ('zip-acq-econ.v1', '75053', 'mf_2_4', 'all', 'all', 2, 0, 1, 1, 0, 1, 0.2, 0.12, 0.31, 'unknown', 0.2, 'metro', 'prior_only:metro', 'metro:dallas-tx', 0, 'indicative_band', 'market:dallas-tx', now());

  begin
    insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
      investor_discount_vs_retail, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
    values ('zip-acq-econ.v1', '75054', 'sfr', 'all', 'all', 30, 4, 5, 21, 3, 4, 0.2, 'unknown', 0.3, 'county', 'own_evidence_only', null, 0.2, 'indicative_band', 'market:dallas-tx', now());
    raise exception 'assert: a prior must be labelled with its level and geography';
  exception when check_violation then null; end;
  begin
    insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
      investor_discount_vs_retail, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
    values ('zip-acq-econ.v1', '75055', 'sfr', 'all', 'all', 30, 4, 5, 21, 3, 4, 0.2, 'unknown', 0.3, 'county', 'shrunk_toward:county', 'county:TX:dallas', 0.2, 'local', 'market:dallas-tx', now());
    raise exception 'assert: local MAO precision on prior-shrunk thin evidence must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
      investor_discount_vs_retail, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
    values ('zip-acq-econ.v1', '75056', 'sfr', 'all', 'all', 30, 10, 12, 8, 9, 11, 0.2, 'unknown', 0.5, 'zip', 'own_evidence_only', null, 1, 'local', 'market:dallas-tx', now());
    raise exception 'assert: local MAO precision below 20 investor + 20 retail sales must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
      investor_discount_vs_retail, typical_exit, confidence, prior_level, prior_label, prior_geo, own_weight, mao_precision, build_scope, last_update)
    values ('zip-acq-econ.v1', '75057', 'sfr', 'all', 'all', 0, 0, 0, 0, 0, 0, null, 'unknown', 0, 'none', 'no_evidence_at_any_level', null, 0, 'indicative_band', 'market:dallas-tx', now());
    raise exception 'assert: guidance without an estimate must be refused';
  exception when check_violation then null; end;
  begin
    insert into public.zip_acquisition_economics (model_version, zip5, property_type, condition_band, value_band, sample_size, investor_n, retail_n, unclassified_n, investor_ratio_n, retail_ratio_n,
      typical_exit, confidence, prior_level, prior_label, own_weight, mao_precision, build_scope, last_update)
    values ('zip-acq-econ.v1', '75058', 'hotel', 'all', 'all', 0, 0, 0, 0, 0, 0, 'unknown', 0, 'none', 'no_evidence_at_any_level', 0, 'none', 'market:dallas-tx', now());
    raise exception 'assert: an unknown property type must be refused';
  exception when check_violation then null; end;

  -- learning loop: a chat claim is recorded, never validated; a closing-grade row validates
  insert into public.acquisition_outcomes (opportunity_id, zip5, property_type, asking_price, final_price, closing_outcome, origin, idempotency_key)
  values ('opp-1', '75051', 'sfr', 180000, 150000, 'closed_purchased', 'seller_chat', 'pt-outcome-chat-1') returning outcome_id into o1;
  begin
    update public.acquisition_outcomes set validation_status = 'validated', validation_source = 'closing_case', validated_by = 'op-1', validated_at = now() where outcome_id = o1;
    raise exception 'assert: a seller-chat outcome must never become validated';
  exception when check_violation then null; end;
  begin
    insert into public.acquisition_outcomes (opportunity_id, closing_outcome, origin, validation_status, idempotency_key)
    values ('opp-2', 'closed_assigned', 'closing_desk', 'validated', 'pt-outcome-2');
    raise exception 'assert: validated without validator / source / final price must be refused';
  exception when check_violation then null; end;
  insert into public.acquisition_outcomes (opportunity_id, zip5, property_type, asking_price, recommended_offer, opening_offer, counters, final_price, retail_reference_value, closing_outcome, time_to_close_days, origin,
    validation_status, validation_source, validated_by, validated_at, idempotency_key)
  values ('opp-3', '75051', 'sfr', 190000, 140000, 128000, '[{"by":"seller","amount":175000},{"by":"us","amount":138000}]'::jsonb, 145000, 200000, 'closed_assigned', 21, 'closing_desk',
    'validated', 'settlement_statement', 'op-1', now(), 'pt-outcome-3') returning outcome_id into o2;
  begin update public.acquisition_outcomes set final_price = 1 where outcome_id = o2; raise exception 'assert: a validated outcome must be immutable'; exception when check_violation then null; end;
  begin delete from public.acquisition_outcomes where outcome_id = o2; raise exception 'assert: a validated outcome must not be deleted'; exception when check_violation then null; end;
  begin
    insert into public.acquisition_outcomes (opportunity_id, closing_outcome, origin, failure_reasons, idempotency_key) values ('opp-4', 'no_contract', 'operator', array['Seller said call me at home'], 'pt-outcome-4');
    raise exception 'assert: failure reasons are codes, not free text';
  exception when check_violation then null; end;
  insert into public.acquisition_outcomes (opportunity_id, closing_outcome, origin, failure_reasons, idempotency_key) values ('opp-5', 'pending', 'operator', array['awaiting_title'], 'pt-outcome-5');

  select count(*) into n from public.acquisition_outcomes_training;
  if n <> 1 then raise exception 'assert: the training view carries ONLY the validated non-pending outcome (got %)', n; end if;
  select count(*) into n from public.acquisition_outcomes_training where opportunity_id = 'opp-1';
  if n <> 0 then raise exception 'assert: a chat claim is never a training row'; end if;

  -- versions: active needs an approver
  insert into public.zip_model_versions (model_version, built_at, sample_size, validated_outcomes_n, confidence, prediction_error) values ('acq-learning.v1@1', now(), 400, 1, 0.5, '{"measured_on":"validated_outcomes_before_update","n":1,"mae":0.03}'::jsonb);
  begin
    insert into public.zip_model_versions (model_version, built_at, sample_size, validated_outcomes_n, confidence, prediction_error, status) values ('acq-learning.v1@2', now(), 400, 1, 0.5, '{"measured_on":"x"}'::jsonb, 'active');
    raise exception 'assert: an active version needs an approver';
  exception when check_violation then null; end;

  -- access: anon / authenticated see nothing; RLS forced
  if has_table_privilege('anon', 'public.zip_acquisition_economics', 'select') or has_table_privilege('authenticated', 'public.acquisition_outcomes', 'select')
     or has_table_privilege('anon', 'public.acquisition_outcomes_training', 'select') then
    raise exception 'assert: anon / authenticated must have no access';
  end if;
  if not has_table_privilege('service_role', 'public.acquisition_outcomes_training', 'select') then raise exception 'assert: service_role reads the training view'; end if;
  if has_table_privilege('service_role', 'public.acquisition_outcomes', 'delete') then raise exception 'assert: service_role may not delete outcomes'; end if;
  select count(*) into n from pg_class where relname in ('zip_acquisition_economics', 'zip_model_build_state', 'zip_model_versions', 'acquisition_outcomes') and relrowsecurity and relforcerowsecurity;
  if n <> 4 then raise exception 'assert: RLS enabled + forced on all four tables (got %)', n; end if;
  raise notice 'posttest(zip_acquisition_intelligence): all assertions OK';
end
$$;
