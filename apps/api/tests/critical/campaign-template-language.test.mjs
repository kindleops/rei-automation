import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanguagePolicyToken, resolveLanguage, normalizeLanguage } from '../../src/lib/sms/language_aliases.js';
import { fetchCanonicalLanguages } from '../../src/lib/domain/campaigns/campaign-recipient-metrics.js';

/**
 * CAMPAIGN-TEMPLATE-LANGUAGE-BRIDGE-1 — a policy token is not a language.
 *
 * THE DEFECT, and it was not "language is null". `campaigns.language_policy`
 * is 'auto' on all 41 campaigns, meaning "decide automatically". The campaign
 * target snapshot fell back to that policy whenever the graph had no language
 * (`row.language || campaign.language_policy || 'auto'`), so 'auto' landed in
 * the target's `language` column, flowed into the template selector as
 * `preferred_language`, and was applied as a literal filter:
 *
 *   .ilike("language", "auto")   ->  0 of 8,784 templates
 *
 * Every fallback level reads from that fetch, including the universal English
 * one, so they all started from an empty set and the target failed
 * `no_template_after_fallback` while being otherwise perfectly ready.
 * Measured 2026-09-15: 997 of 2,587 campaign_targets carried 'auto'; 0
 * templates did.
 *
 * The English default already existed in two places — it just never got the
 * chance to apply, because 'auto' is a non-empty string.
 */

test('policy tokens are recognised as policies, not languages', () => {
  for (const token of ['auto', 'AUTO', ' auto ', 'automatic', 'unknown', 'unspecified', 'any', 'default', 'none', 'null']) {
    assert.equal(isLanguagePolicyToken(token), true, `${token} must be treated as a policy token`);
  }
});

test('real languages are never mistaken for policy tokens', () => {
  for (const language of ['English', 'Spanish', 'Mandarin', 'Portuguese', 'Vietnamese', 'Arabic']) {
    assert.equal(isLanguagePolicyToken(language), false, language);
    assert.equal(normalizeLanguage(language), language, `${language} must normalise to itself`);
  }
});

test('resolveLanguage reports a policy token as no language stated', () => {
  const resolved = resolveLanguage('auto');
  assert.equal(resolved.canonical, null, 'a policy token must not become a canonical language');
  assert.equal(resolved.unsupported, false, 'it is not an unsupported language, it is not a language');
  assert.equal(resolved.policy_token, true);
});

/**
 * The distinction that matters: an UNSUPPORTED language is a real language we
 * cannot template (hold the message); a POLICY token means nothing was stated
 * (apply the default). Collapsing them would either send the wrong language or
 * block everything.
 */
test('a policy token is not the same as an unsupported language', () => {
  const policy = resolveLanguage('auto');
  const unsupported = resolveLanguage('Thai');
  assert.equal(policy.unsupported, false);
  assert.equal(unsupported.unsupported, true, 'Thai is a real language with no templates — hold, do not default');
});

test('an empty value is simply unstated', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const resolved = resolveLanguage(empty);
    assert.equal(resolved.canonical, null);
    assert.equal(resolved.unsupported, false);
  }
});

// ─────────────────────────────────────── canonical language resolution (§4A)

/** Stands in for the prospects / master_owners reads. */
function fakeSupabase({ prospects = [], owners = [] } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const state = { table, ids: null };
      const builder = {
        select() { return builder; },
        in(_column, ids) {
          state.ids = ids;
          calls.push({ table, count: ids.length });
          const rows = table === 'prospects'
            ? prospects.filter((r) => ids.includes(r.individual_key))
            : owners.filter((r) => ids.includes(r.master_owner_id));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

test('a known seller language comes from the person, not the owner entity', async () => {
  const lookup = await fetchCanonicalLanguages(
    [{ seller_person_key: 'pk_1', master_owner_id: 'mo_1' }],
    {
      supabase: fakeSupabase({
        prospects: [{ individual_key: 'pk_1', language_preference: 'Spanish' }],
        owners: [{ master_owner_id: 'mo_1', best_language: 'English' }],
      }),
    },
  );
  const resolved = lookup.resolve({ seller_person_key: 'pk_1', master_owner_id: 'mo_1' });
  assert.equal(resolved.language, 'Spanish', 'the person being messaged outranks the owning entity');
  assert.equal(resolved.source, 'prospect');
});

test('the owner entity is the fallback when the person has no language', async () => {
  const lookup = await fetchCanonicalLanguages(
    [{ seller_person_key: 'pk_2', master_owner_id: 'mo_2' }],
    { supabase: fakeSupabase({ prospects: [], owners: [{ master_owner_id: 'mo_2', best_language: 'Vietnamese' }] }) },
  );
  const resolved = lookup.resolve({ seller_person_key: 'pk_2', master_owner_id: 'mo_2' });
  assert.equal(resolved.language, 'Vietnamese');
  assert.equal(resolved.source, 'master_owner');
});

/**
 * §5/§8 — unknown must stay unknown. Nothing may be written back to the graph
 * and no language may be asserted about the seller.
 */
test('unknown language stays unknown and is never guessed as English', async () => {
  const lookup = await fetchCanonicalLanguages(
    [{ seller_person_key: 'pk_3', master_owner_id: null }],
    { supabase: fakeSupabase({ prospects: [], owners: [] }) },
  );
  const resolved = lookup.resolve({ seller_person_key: 'pk_3' });
  assert.equal(resolved.language, null, 'no language known means no language claimed');
  assert.equal(resolved.source, 'unknown');
});

/** Language is an enrichment, never a gate — a failed read must not block. */
test('an unreadable language source degrades to unknown rather than throwing', async () => {
  const broken = {
    from() {
      return {
        select() { return this; },
        in() { return Promise.resolve({ data: null, error: { message: 'permission denied' } }); },
      };
    },
  };
  const lookup = await fetchCanonicalLanguages([{ seller_person_key: 'pk_4' }], { supabase: broken });
  assert.equal(lookup.resolve({ seller_person_key: 'pk_4' }).language, null);
});

test('language lookups are set-based, not one target at a time', async () => {
  const rows = Array.from({ length: 1100 }, (_, i) => ({ seller_person_key: `pk_${i}`, master_owner_id: `mo_${i}` }));
  const client = fakeSupabase();
  await fetchCanonicalLanguages(rows, { supabase: client });
  assert.ok(client.calls.length <= 6, `1100 rows must chunk, not fan out: ${client.calls.length} calls`);
  assert.ok(client.calls.every((c) => c.count <= 500), 'no chunk may exceed the chunk size');
});

test('rows with no identity keys make no query at all', async () => {
  const client = fakeSupabase();
  const lookup = await fetchCanonicalLanguages([{ seller_person_key: null, master_owner_id: null }], { supabase: client });
  assert.equal(client.calls.length, 0);
  assert.equal(lookup.resolve({}).language, null);
});

test('duplicate identity keys are collapsed before the lookup', async () => {
  const client = fakeSupabase();
  await fetchCanonicalLanguages(
    [{ seller_person_key: 'pk_1' }, { seller_person_key: 'pk_1' }, { seller_person_key: 'pk_2' }],
    { supabase: client },
  );
  const prospectCall = client.calls.find((c) => c.table === 'prospects');
  assert.equal(prospectCall.count, 2, 'two distinct keys, not three rows');
});
