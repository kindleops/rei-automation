import { getThreadMessages } from './apps/api/src/lib/domain/inbox/live-inbox-service.js';
import { supabase } from './apps/api/src/lib/supabase/client.js';

async function run() {
  try {
    const res = await getThreadMessages('+14802257752', null, null, null, supabase, true);
    console.log(res);
  } catch (err) {
    console.error(err);
  }
}
run();
