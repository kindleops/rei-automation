import fs from 'fs';
let code = fs.readFileSync('api/internal/queue/runner.ts', 'utf8');

const helperCode = `
    const updateWithTaxonomy = async (itemId: string, payload: any, currentMeta: any) => {
      if (['blocked', 'cancelled', 'paused_invalid_queue_row', 'failed'].includes(payload.queue_status)) {
        const tax = classifyQueueFailureReason({ ...payload, metadata: { ...currentMeta, ...(payload.metadata || {}) } })
        payload.metadata = {
          ...currentMeta,
          ...(payload.metadata || {}),
          failure_category: tax.category,
          failure_reason_normalized: tax.reason_normalized,
          failure_is_true_delivery_failure: tax.is_true_delivery_failure,
          failure_is_data_hygiene: tax.is_data_hygiene,
          failure_is_repeat_contact_risk: tax.is_repeat_contact_risk
        }
      }
      return supabase.from('send_queue').update(payload).eq('id', itemId)
    }
`;

code = code.replace(/const sentPerMarket = new Map<string, number>\(\)/, `const sentPerMarket = new Map<string, number>()\n${helperCode}`);
code = code.replace(/await supabase\.from\('send_queue'\)\.update\(([\s\S]*?)\)\.eq\('id', itemId\)/g, 'await updateWithTaxonomy(itemId, $1, currentMetadata)');

fs.writeFileSync('api/internal/queue/runner.ts', code);