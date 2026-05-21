import fs from "fs";
const file = "supabase/migrations/20260511000005_inbox_panel_ui_refinements.sql";
let content = fs.readFileSync(file, "utf8");

// 1. Add phone_owner to phone_links
content = content.replace(
  'ph.primary_prospect_id as ph_prospect_id',
  'ph.primary_prospect_id as ph_prospect_id,\n    ph.phone_owner as ph_phone_carrier'
);

// 2. Add phone_carrier to resolved_ids
content = content.replace(
  'b.final_property_id as resolved_property_id\n  FROM base b',
  'b.final_property_id as resolved_property_id,\n    pl.ph_phone_carrier as resolved_phone_carrier\n  FROM base b'
);

// 3. Add age calculation, buying_power, and phone_carrier to main SELECT
content = content.replace(
  'pr.net_asset_value,',
  'pr.net_asset_value,\n  (date_part(\'year\', CURRENT_DATE) - cast(NULLIF(substring(pr.mob, 1, 4), \'\') as integer)) as prospect_age,'
);

// We need to add phone_carrier in the main select.
// Right after r.final_resolved_property_id as property_id,
content = content.replace(
  'r.final_resolved_property_id as property_id,',
  'r.final_resolved_property_id as property_id,\n  r.resolved_phone_carrier as phone_carrier,\n  NULL::integer as sfr_count,\n  NULL::integer as mf_count,'
);

// Also the user mentioned marital status. If education model and marital status are swapped, let"s swap them!
// "MARITAL STATUS (shows as for example Some College - Likely)"
content = content.replace(
  'pr.marital_status,\n  pr.education_model,',
  'pr.education_model as marital_status,\n  pr.marital_status as education_model,'
);

fs.writeFileSync(file, content);
console.log("Updated migration script!");
