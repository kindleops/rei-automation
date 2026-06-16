import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { getUniversalDealDossier } = await import('./src/lib/cockpit/universal-deal-dossier-service.js');
  console.log("Fetching Universal Deal Dossier...");
  
  try {
    const dossier = await getUniversalDealDossier({
      thread_key: "+14802257752",
      debug: true
    });
    
    console.log(JSON.stringify({
      ok: true,
      identity: dossier.identity,
      property: !!dossier.property?.property_id,
      prospect: !!dossier.prospect?.prospect_id,
      owner: !!dossier.master_owner?.master_owner_id,
      phone: !!dossier.primary_phone?.canonical_e164,
      messages_count: dossier.messages?.length || 0,
      property_data: dossier.property
    }, null, 2));
    
  } catch (err) {
    console.error("Error:", err);
  }
}

main().catch(console.error);
