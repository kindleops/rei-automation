/**
 * A generic second brand for proving the core is brand-agnostic. It is never
 * registered in production (see scheduling-runtime.js) and its event types are
 * environment 'test', which production availability refuses to serve.
 *
 * Its related records are deliberately unlike Prominent's — "account:<id>",
 * "workspace:<id>" — the core must not care.
 */

export const TEST_BRAND = 'second_brand_test';

export function createTestBrandAdapter(deps = {}) {
  const sent = deps.sent ?? [];
  const owners = deps.owners ?? {};
  return {
    brand_key: TEST_BRAND,
    sent,
    async resolveOwner({ role, refs }) {
      const account = (refs || []).find((r) => String(r).startsWith('account:'));
      return role === 'account_owner' && account ? owners[account] ?? null : null;
    },
    describe({ eventType }) {
      return { summary: `Second brand · ${eventType.name}`, description: 'Test appointment.' };
    },
    async onChange(kind, { appointment }) {
      sent.push({ kind, appointment_id: appointment.id });
    },
    reminder({ offsetMinutes }) {
      return { subject: `Reminder (${offsetMinutes} min)`, html: '<p>Reminder</p>', text: 'Reminder' };
    },
  };
}
