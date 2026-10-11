-- ROLLBACK for PROPOSED_20261010200000_eg_property_facts_field_accuracy.sql. Drops the addendum columns (and their indexes) only; reads fall back to the live computation.
begin;
set local lock_timeout = '3s';
alter table public.eg_property_facts drop column if exists "property_type_class";
alter table public.eg_property_facts drop column if exists "property_type_group";
alter table public.eg_property_facts drop column if exists "property_type_confidence";
alter table public.eg_property_facts drop column if exists "property_type_basis";
alter table public.eg_property_facts drop column if exists "property_use_raw";
alter table public.eg_property_facts drop column if exists "person_source";
commit;
