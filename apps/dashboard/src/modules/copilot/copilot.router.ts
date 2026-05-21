export const routeQueryToAgent = (query: string, currentAgentId: string): string => {
  const text = query.toLowerCase();
  
  // Explicit mentions
  if (text.includes('ceo')) return 'ceo';
  if (text.includes('coo')) return 'coo';
  if (text.includes('cfo')) return 'cfo';
  if (text.includes('underwriter')) return 'underwriter';
  if (text.includes('acquisitions') || text.includes('acq chief')) return 'acquisitions';
  if (text.includes('dispo')) return 'dispo';
  if (text.includes('title')) return 'title';
  if (text.includes('compliance')) return 'compliance';
  if (text.includes('data doctor') || text.includes('doctor')) return 'data';

  // Intent matching
  if (text.includes('strategy') || text.includes('priority')) return 'ceo';
  if (text.includes('workflow') || text.includes('stuck') || text.includes('queue')) return 'coo';
  if (text.includes('margin') || text.includes('profit') || text.includes('capital')) return 'cfo';
  if (text.includes('arv') || text.includes('mao') || text.includes('comps') || text.includes('repair') || text.includes('underwrite')) return 'underwriter';
  if (text.includes('reply') || text.includes('negotiate') || text.includes('say to seller') || text.includes('draft')) return 'acquisitions';
  if (text.includes('buyer') || text.includes('exit') || text.includes('sell this')) return 'dispo';
  if (text.includes('close') || text.includes('probate') || text.includes('lien') || text.includes('contract')) return 'title';
  if (text.includes('opt out') || text.includes('dnc') || text.includes('legal') || text.includes('suppress') || text.includes('hostile')) return 'compliance';
  if (text.includes('missing data') || text.includes('broken') || text.includes('sync') || text.includes('bug')) return 'data';

  return currentAgentId;
};
