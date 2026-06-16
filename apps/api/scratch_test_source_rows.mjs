import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const property_id = "2157300043";
  const master_owner_id = "mo_2a41bc3d4c37ffa8ca633977";
  const phone = "+14802257752";
  
  console.log("PROPERTY:");
  const { data: prop } = await supabase.from('properties').select('*').eq('property_id', property_id).maybeSingle();
  const propFiltered = prop ? {
    market: prop.market, property_type: prop.property_type, estimated_value: prop.estimated_value, 
    equity_amount: prop.equity_amount, equity_percent: prop.equity_percent,
    property_address_city: prop.property_address_city, property_address_state: prop.property_address_state, 
    property_address_zip: prop.property_address_zip, property_address_county_name: prop.property_address_county_name, 
    building_square_feet: prop.building_square_feet, year_built: prop.year_built,
    total_bedrooms: prop.total_bedrooms, total_baths: prop.total_baths, units_count: prop.units_count, 
    tax_delinquent: prop.tax_delinquent, active_lien: prop.active_lien
  } : null;
  console.log(JSON.stringify(propFiltered, null, 2));

  console.log("\nMASTER OWNER:");
  const { data: owner } = await supabase.from('master_owners').select('*').eq('master_owner_id', master_owner_id).maybeSingle();
  const ownerFiltered = owner ? {
    owner_type_guess: owner.owner_type_guess, contactability_score: owner.contactability_score, 
    financial_pressure_score: owner.financial_pressure_score, urgency_score: owner.urgency_score, 
    priority_score: owner.priority_score, priority_tier: owner.priority_tier, 
    follow_up_cadence: owner.follow_up_cadence, portfolio_total_value: owner.portfolio_total_value, 
    portfolio_total_equity: owner.portfolio_total_equity, property_count: owner.property_count,
    tax_delinquent_count: owner.tax_delinquent_count, active_lien_count: owner.active_lien_count
  } : null;
  console.log(JSON.stringify(ownerFiltered, null, 2));

  console.log("\nPHONE:");
  const { data: ph } = await supabase.from('phone_numbers').select('*').eq('canonical_e164', phone).maybeSingle();
  const phFiltered = ph ? {
    phone_owner: ph.phone_owner, activity_status: ph.activity_status, 
    usage_12_months: ph.usage_12_months, usage_2_months: ph.usage_2_months
  } : null;
  console.log(JSON.stringify(phFiltered, null, 2));
}

main().catch(console.error);
