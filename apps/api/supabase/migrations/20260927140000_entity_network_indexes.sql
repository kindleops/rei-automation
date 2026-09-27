-- Entity Graph relationship network: the joins behind "who else is really
-- behind this owner" (same household / same owner cluster / same mailing
-- address), the largest-networks landing list, and a property's sale history.
-- Additive indexes only.
CREATE INDEX IF NOT EXISTS idx_master_owners_household_key ON public.master_owners (household_key) WHERE household_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_owners_owner_cluster_key ON public.master_owners (owner_cluster_key) WHERE owner_cluster_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_owners_primary_owner_address ON public.master_owners (primary_owner_address) WHERE primary_owner_address IS NOT NULL AND primary_owner_address <> '';
CREATE INDEX IF NOT EXISTS idx_master_owners_property_count ON public.master_owners (property_count DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS mv_map_sold_comps_property_id ON public.mv_map_sold_comps (property_id) WHERE property_id IS NOT NULL;
