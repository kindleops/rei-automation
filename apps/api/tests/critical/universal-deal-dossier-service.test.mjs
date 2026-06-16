import test from "node:test";
import assert from "node:assert/strict";
import { getUniversalDealDossier } from "../../src/lib/cockpit/universal-deal-dossier-service.js";

// Mocking the getUniversalDealDossier function or testing the normalizers.
// Actually, getUniversalDealDossier uses supabase which will try to hit the DB.
// The prompt says:
// command.contact_threads is an object:
// {
// threads: [
// { channel: "phone", value: "+14802257752" }
// ],
// thread_count: 1
// }
// Expected:
// * service does not throw
// * phones array has 1 item
// * dossier returns ok/usable payload

// Since it calls supabase, let's mock supabase or test by just importing it if we are allowed.
// But wait, the prompt says "Also add route-level hydration test if test harness exists".
// There is no explicit test harness for routes, but I'll write a test that mocks `supabase.from`.
import { supabase } from "../../src/lib/supabase/client.js";

test("getUniversalDealDossier handles contact_threads object instead of array safely", async (t) => {
  // Mock supabase query to return our specific command object
  const originalFrom = supabase.from;
  
  t.mock.method(supabase, 'from', (table) => {
    if (table === 'inbox_thread_state') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { property_id: '123', prospect_id: '456', canonical_e164: '+14802257752' } })
          })
        })
      };
    }
    
    if (table === 'v_universal_lead_command') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    thread_key: '+14802257752',
                    property_id: '123',
                    contact_threads: {
                      threads: [
                        { channel: 'phone', value: '+14802257752' }
                      ],
                      thread_count: 1
                    }
                  }
                })
              })
            })
          })
        })
      };
    }
    
    // For other tables, just return null data to simulate no enrichment
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null }),
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: null })
            })
          })
        })
      })
    };
  });

  const dossier = await getUniversalDealDossier({ thread_key: "+14802257752" });

  assert.ok(dossier, "Dossier should be returned");
  assert.equal(dossier.phones.length, 1, "phones array should have 1 item");
  assert.equal(dossier.phones[0].channel, "phone", "phone channel should match");
  assert.equal(dossier.identity.thread_key, "+14802257752", "thread key should match");
});
