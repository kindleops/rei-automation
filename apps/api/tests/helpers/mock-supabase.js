export function buildMockSupabase(overrides = {}) {
  const inserted = [];
  const updated = [];
  const selected = [];

  const from = (table) => {
    return {
      insert: (payload) => {
        inserted.push({ table, payload });
        return {
          select: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: { id: inserted.length, ...payload },
                error: null,
              }),
          }),
        };
      },
      update: (payload) => {
        updated.push({ table, payload });
        return {
          eq: () => ({
            select: () => Promise.resolve({ data: [payload], error: null }),
          }),
          select: () => Promise.resolve({ data: [payload], error: null }),
        };
      },
      select: () => ({
        in: () => ({
           order: () => ({
             maybeSingle: () => Promise.resolve({ data: null, error: null }),
           }),
           order: () => ({
             then: (cb) => cb({ data: [], error: null }),
           }),
        }),
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: selected.find((r) => r.table === table) || null,
              error: null,
            }),
        }),
        maybeSingle: () =>
          Promise.resolve({
            data: selected.find((r) => r.table === table) || null,
            error: null,
          }),
      }),
      ...overrides,
    };
  };

  return {
    from,
    _inserted: inserted,
    _updated: updated,
    _selected: selected,
  };
}
