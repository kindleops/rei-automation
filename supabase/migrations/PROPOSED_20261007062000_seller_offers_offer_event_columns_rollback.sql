begin;
alter table public.seller_offers drop column if exists quote_type, drop column if exists engine_version, drop column if exists operator_id, drop column if exists offer_source;
commit;
