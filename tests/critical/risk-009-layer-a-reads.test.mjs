import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

test('Guard against direct Supabase reads in dashboard frontend', () => {
  const files = globSync('apps/dashboard/src/**/*.{ts,tsx,js,jsx}');
  
  const blockedPatterns = [
    /from\s*\(\s*['"]message_events['"]\s*\)/,
    /from\s*\(\s*['"]phones['"]\s*\)/,
    /from\s*\(\s*['"]phone_numbers['"]\s*\)/,
    /from\s*\(\s*['"]master_owners['"]\s*\)/,
    /from\s*\(\s*['"][^'"]*_kpis_v['"]\s*\)/,
    /\.rpc\s*\(\s*['"]get_buyers_for_property['"]\s*\)/,
  ];

  const violations = [];

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of blockedPatterns) {
      if (pattern.test(content)) {
        violations.push(`File ${file} contains blocked pattern ${pattern}`);
      }
    }
  }

  if (violations.length > 0) {
    assert.fail(`Found direct Supabase reads:\n${violations.join('\n')}`);
  }
});
