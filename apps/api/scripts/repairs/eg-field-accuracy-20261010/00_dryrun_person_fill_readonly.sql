-- READ-ONLY dry run (2026-10-10). Per person field: public.prospects rows whose value is empty while the SAME vendor
-- person (seller.owner, same individual_key) carries one. Nothing is written. Run with statement_timeout 15s.
set default_transaction_read_only = on;
set statement_timeout = '15s';
select
  count(*)                                                                                             as prospects_with_seller_owner,
  count(*) filter (where nullif(btrim(p.language_preference), '') is null and nullif(btrim(o.language_preference), '') is not null)   as fill_language_preference,
  count(*) filter (where nullif(btrim(p.gender), '') is null and nullif(btrim(o.gender), '') is not null)                             as fill_gender,
  count(*) filter (where nullif(btrim(p.marital_status), '') is null and nullif(btrim(o.marital_status), '') is not null)             as fill_marital_status,
  count(*) filter (where nullif(btrim(p.occupation_group), '') is null and nullif(btrim(o.occupation_group), '') is not null)         as fill_occupation_group,
  count(*) filter (where nullif(btrim(p.education_model), '') is null and nullif(btrim(o.education_model), '') is not null)           as fill_education_model,
  count(*) filter (where nullif(btrim(p.est_household_income), '') is null and nullif(btrim(o.est_household_income), '') is not null) as fill_est_household_income,
  count(*) filter (where nullif(btrim(p.net_asset_value), '') is null and nullif(btrim(o.net_asset_value), '') is not null)           as fill_net_asset_value,
  count(*) filter (where nullif(btrim(p.buying_power), '') is null and nullif(btrim(o.buying_power), '') is not null)                 as fill_buying_power,
  count(*) filter (where (p.mob is null or p.mob !~ '^\d{6}$') and o.month_of_birth ~ '^\d{6}$')                                  as fill_mob,
  -- disagreement where BOTH carry a value (never overwritten; reported for the QA brief)
  count(*) filter (where nullif(btrim(p.gender), '') is not null and nullif(btrim(o.gender), '') is not null and p.gender <> o.gender) as differ_gender,
  count(*) filter (where p.mob ~ '^\d{6}$' and o.month_of_birth ~ '^\d{6}$' and p.mob <> o.month_of_birth)                         as differ_mob
from public.prospects p
join seller.owner o on o.individual_key = p.individual_key;
