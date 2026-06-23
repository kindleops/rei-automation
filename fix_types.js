const fs = require('fs');
let file = fs.readFileSync('apps/dashboard/src/lib/data/inboxData.ts', 'utf8');

file = file.replace(/const key = event.thread_key \|\| phones \|\| 'unknown'/g, "const key = String(event.thread_key || phones || 'unknown')");
file = file.replace(/const t = threadsMap.get\(key\)!/g, "const t = threadsMap.get(key as string)!");
file = file.replace(/queueIdsToFetch\.add\(t\.queue_id\)/g, "queueIdsToFetch.add(t.queue_id as string)");
file = file.replace(/queueRows\[row\.id\] = row/g, "queueRows[row.id as string] = row");
file = file.replace(/if \(t\.queue_id && queueRows\[t\.queue_id\]\) \{/g, "if (t.queue_id && queueRows[t.queue_id as string]) {");
file = file.replace(/const q = queueRows\[t\.queue_id\]/g, "const q = queueRows[t.queue_id as string]");
file = file.replace(/masterOwnerIds\.add\(t\.master_owner_id\)/g, "masterOwnerIds.add(t.master_owner_id as string)");
file = file.replace(/propertyIds\.add\(t\.property_id\)/g, "propertyIds.add(t.property_id as string)");
file = file.replace(/prospectIds\.add\(t\.prospect_id\)/g, "prospectIds.add(t.prospect_id as string)");
file = file.replace(/const mo = masterOwnersMap\.get\(t\.master_owner_id\)/g, "const mo = masterOwnersMap.get(t.master_owner_id as string)");
file = file.replace(/const prop = propertiesMap\.get\(t\.property_id\)/g, "const prop = propertiesMap.get(t.property_id as string)");
file = file.replace(/const pros = prospectsMap\.get\(t\.prospect_id\)/g, "const pros = prospectsMap.get(t.prospect_id as string)");
file = file.replace(/let diagnostics: Record<string, any> = \{\}/g, "");
file = file.replace(/data = hydrated\.threads\n    diagnostics = hydrated\.diagnostics/g, "data = hydrated.threads\n    // diagnostics = hydrated.diagnostics");

fs.writeFileSync('apps/dashboard/src/lib/data/inboxData.ts', file);
