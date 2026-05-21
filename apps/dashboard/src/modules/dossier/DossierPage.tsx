import React, { useEffect, useMemo, useState } from 'react';
import type { DossierFilter, DossierModel, DossierView, Property, SellerDossier, TimelineEvent } from './dossier.types';

interface DossierPageProps {
  data: DossierModel;
}

type DossierCommand = {
  label: string;
  category: string;
  shortcut: string;
  description: string;
};

const DOSSIER_VIEWS: DossierView[] = ['overview', 'properties', 'conversation', 'motivation', 'deals', 'timeline'];

const titleCase = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());

const formatMoney = (value: number | undefined) => {
  if (!value) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${(value / 1_000).toFixed(0)}k`;
};

const formatDate = (value?: string) => {
  if (!value) return 'No activity';
  return new Date(value).toLocaleDateString();
};

const getSeverityClass = (event: TimelineEvent) => {
  if (event.severity === 'high') return 'dossier-timeline-item--high';
  if (event.severity === 'medium') return 'dossier-timeline-item--medium';
  return 'dossier-timeline-item--low';
};

const getTimelineIcon = (type: string) => {
  const normalized = type.toLowerCase();
  if (normalized.includes('message')) return 'MSG';
  if (normalized.includes('offer')) return 'OFR';
  if (normalized.includes('call')) return 'CAL';
  if (normalized.includes('visit')) return 'VIS';
  if (normalized.includes('title')) return 'TTL';
  return 'EVT';
};

const getTemperatureClass = (temperature: string) => `dossier-temp-pill dossier-temp-pill--${temperature}`;

export const DossierPage: React.FC<DossierPageProps> = ({ data }) => {
  const [sellers] = useState(data.sellers);
  const [selectedSeller, setSelectedSeller] = useState<SellerDossier | null>(sellers[0] || null);
  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [activeView, setActiveView] = useState<DossierView>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<DossierFilter>({});
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');

  const dossierCommands: DossierCommand[] = [
    { label: 'Show hot sellers', category: 'Filter', shortcut: '', description: 'Display only hot and urgent sellers' },
    { label: 'Show warm sellers', category: 'Filter', shortcut: '', description: 'Display warm opportunities' },
    { label: 'Show high equity owners', category: 'Filter', shortcut: '', description: 'Filter to high equity portfolios' },
    { label: 'Show distressed owners', category: 'Filter', shortcut: '', description: 'Focus distress and distress-adjacent signals' },
    { label: 'Show out-of-state owners', category: 'Filter', shortcut: '', description: 'Focus absentee owner opportunities' },
    { label: 'Search owners', category: 'Filter', shortcut: 'Cmd+F', description: 'Focus owner search field' },
    { label: 'Open selected in Inbox', category: 'Seller Actions', shortcut: 'O', description: 'Pivot into communications workspace' },
    { label: 'Schedule follow-up', category: 'Seller Actions', shortcut: 'F', description: 'Queue outreach sequence' },
    { label: 'Generate offer', category: 'Seller Actions', shortcut: 'G', description: 'Generate recommended acquisition offer' },
    { label: 'Mark seller hot', category: 'Seller Actions', shortcut: 'H', description: 'Promote to top-priority queue' },
    { label: 'Add seller note', category: 'Seller Actions', shortcut: 'N', description: 'Add operator context note' },
    { label: 'Open property profile', category: 'Property Actions', shortcut: '', description: 'Open property intelligence detail' },
    { label: 'Map property focus', category: 'Property Actions', shortcut: 'M', description: 'Center map to selected address' },
    { label: 'Create contract', category: 'Deal Actions', shortcut: '', description: 'Create deal contract draft' },
    { label: 'Send to title', category: 'Deal Actions', shortcut: '', description: 'Open title processing workflow' },
    { label: 'View motivation analysis', category: 'Intelligence', shortcut: '', description: 'Review motivation model signals' },
    { label: 'View deal recommendations', category: 'Intelligence', shortcut: '', description: 'Review AI strategy stack' },
  ];

  const filteredCommands = commandSearch
    ? dossierCommands.filter(
        (command) =>
          command.label.toLowerCase().includes(commandSearch.toLowerCase()) ||
          command.description.toLowerCase().includes(commandSearch.toLowerCase()) ||
          command.category.toLowerCase().includes(commandSearch.toLowerCase())
      )
    : dossierCommands;

  const groupedCommands = filteredCommands.reduce((acc, command) => {
    if (!acc[command.category]) {
      acc[command.category] = [];
    }
    acc[command.category].push(command);
    return acc;
  }, {} as Record<string, DossierCommand[]>);

  const filteredSellers = sellers.filter((seller) => {
    if (
      searchQuery &&
      !seller.displayName.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !seller.market.toLowerCase().includes(searchQuery.toLowerCase())
    ) {
      return false;
    }
    if (filters.temperature && seller.temperature !== filters.temperature) return false;
    if (filters.highEquity && !seller.properties.some((property) => property.highEquity)) return false;
    if (filters.hasDistress && !seller.properties.some((property) => property.distressSignals.length > 0)) return false;
    if (filters.corporate && !seller.corporateOwner) return false;
    if (filters.outOfState && !seller.outOfStateOwner) return false;
    if (filters.portfolioOwners && seller.propertyCount <= 3) return false;
    return true;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea')) return;

      const isCmd = event.ctrlKey || event.metaKey;

      if (isCmd && event.key === 'k') {
        event.preventDefault();
        setShowCommandPalette((state) => !state);
      } else if (!isCmd && event.key === 'Escape') {
        setSelectedProperty(null);
      } else if (!isCmd && event.key >= '1' && event.key <= '6') {
        setActiveView(DOSSIER_VIEWS[parseInt(event.key, 10) - 1]);
      } else if (!isCmd && event.key === 'f') {
        event.preventDefault();
        if (selectedSeller) console.log('Schedule follow-up for', selectedSeller.displayName);
      } else if (!isCmd && event.key === 'o') {
        event.preventDefault();
        if (selectedSeller) console.log('Open Inbox for', selectedSeller.displayName);
      } else if (!isCmd && event.key === 'g') {
        event.preventDefault();
        if (selectedSeller) console.log('Generate offer for', selectedSeller.displayName);
      } else if (!isCmd && event.key === 'm') {
        event.preventDefault();
        if (selectedSeller) console.log('Map focus for', selectedSeller.displayName);
      } else if (!isCmd && event.key === 'h') {
        event.preventDefault();
        if (selectedSeller) console.log('Mark hot:', selectedSeller.displayName);
      } else if (!isCmd && event.key === 'n') {
        event.preventDefault();
        if (selectedSeller) console.log('Add note for', selectedSeller.displayName);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSeller]);

  const handleCommandSelect = (command: DossierCommand) => {
    console.log('Command selected:', command.label);
    setShowCommandPalette(false);
    setCommandSearch('');
  };

  const sellerLastActivity = selectedSeller?.conversations[0]?.lastMessageAt;

  const portfolioSignals = useMemo(
    () =>
      (selectedSeller?.properties ?? [])
        .flatMap((property) => property.distressSignals)
        .filter((value, index, source) => source.indexOf(value) === index)
        .slice(0, 8),
    [selectedSeller]
  );

  const motivationRows = useMemo(
    () =>
      portfolioSignals.map((signal, index) => {
        const base = selectedSeller?.motivationScore ?? 50;
        const strength = Math.max(28, Math.min(96, base - index * 7 + (signal.length % 9)));
        return {
          signal,
          strength,
          group: signal.includes('tax') || signal.includes('foreclosure') || signal.includes('probate') ? 'Urgency' : 'Behavioral',
        };
      }),
    [portfolioSignals, selectedSeller]
  );

  const conversionWindow = useMemo(() => {
    const score = selectedSeller?.motivationScore ?? 0;
    if (score >= 82) return '7-14 days';
    if (score >= 65) return '14-30 days';
    if (score >= 48) return '30-60 days';
    return '60+ days';
  }, [selectedSeller]);

  const renderOverview = () => (
    <div className="dossier-view">
      <div className="dossier-view-grid dossier-view-grid--overview">
        <section className="dossier-card dossier-card--summary">
          <div className="dossier-card__title">AI Summary</div>
          <p className="dossier-card__body">
            {selectedSeller?.conversations[0]?.aiSummary || 'No conversation intelligence available yet.'}
          </p>
          <div className="dossier-inline-meta">
            <span className="dossier-chip">Confidence {selectedSeller?.aiConfidence ?? 0}%</span>
            <span className="dossier-chip">Risk {selectedSeller?.riskScore ?? 0}</span>
            <span className="dossier-chip">Preferred {titleCase(selectedSeller?.preferredChannel || 'sms')}</span>
          </div>
        </section>

        <section className="dossier-card">
          <div className="dossier-card__title">Key Facts</div>
          <div className="dossier-fact-grid">
            <div className="dossier-fact-row"><span>Owner Type</span><strong>{titleCase(selectedSeller?.ownerType || 'unknown')}</strong></div>
            <div className="dossier-fact-row"><span>Market</span><strong>{selectedSeller?.market}</strong></div>
            <div className="dossier-fact-row"><span>Language</span><strong>{selectedSeller?.language}</strong></div>
            <div className="dossier-fact-row"><span>Best Contact</span><strong>{selectedSeller?.bestContactTime}</strong></div>
            <div className="dossier-fact-row"><span>Primary Channel</span><strong>{titleCase(selectedSeller?.preferredChannel || 'sms')}</strong></div>
            <div className="dossier-fact-row"><span>Linked Prospects</span><strong>{selectedSeller?.linkedProspectsCount}</strong></div>
          </div>
        </section>

        <section className="dossier-card">
          <div className="dossier-card__title">Top Motivation Signals</div>
          <div className="dossier-chip-cloud">
            {portfolioSignals.length > 0 ? (
              portfolioSignals.map((signal) => (
                <span key={signal} className="dossier-chip dossier-chip--signal">{titleCase(signal)}</span>
              ))
            ) : (
              <span className="dossier-muted">No active motivation signals</span>
            )}
          </div>
        </section>

        <section className="dossier-card">
          <div className="dossier-card__title">Recommended Strategy</div>
          <p className="dossier-card__body">{selectedSeller?.properties[0]?.recommendedStrategy || 'Standard acquisition sequence'}</p>
          <div className="dossier-inline-meta">
            <span className="dossier-chip">Window {conversionWindow}</span>
            <span className="dossier-chip">Priority {titleCase(selectedSeller?.priority || 'medium')}</span>
          </div>
        </section>

        <section className="dossier-card dossier-card--activity">
          <div className="dossier-card__title">Recent Activity</div>
          <div className="dossier-activity-list">
            {selectedSeller?.timeline.slice(0, 5).map((event) => (
              <div key={event.id} className="dossier-activity-row">
                <span className="dossier-activity-dot" />
                <div className="dossier-activity-content">
                  <div className="dossier-activity-label">{event.label}</div>
                  <div className="dossier-activity-desc">{event.description}</div>
                </div>
                <span className="dossier-activity-time">{formatDate(event.timestamp)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );

  const renderProperties = () => (
    <div className="dossier-view">
      <div className="dossier-properties-grid">
        {selectedSeller?.properties.map((property) => {
          const propertyFlags = [
            property.taxDelinquent && 'Tax Delinquent',
            property.absentee && 'Absentee',
            selectedSeller.outOfStateOwner && 'Out Of State',
            property.tiredLandlord && 'Tired Landlord',
            property.vacant && 'Vacant',
            property.highEquity && 'High Equity',
          ].filter(Boolean) as string[];

          return (
            <article
              key={property.propertyId}
              className={`dossier-property-card ${selectedProperty?.propertyId === property.propertyId ? 'dossier-property-card--selected' : ''}`}
              onClick={() => setSelectedProperty(property)}
            >
              <header className="dossier-property-top">
                <div>
                  <div className="dossier-property-address">{property.address}</div>
                  <div className="dossier-property-loc">{property.city}, {property.state} {property.zip}</div>
                </div>
                <span className="dossier-property-score">AI {property.aiPropertyScore}</span>
              </header>

              <div className="dossier-property-specs">
                <span>{titleCase(property.propertyType)}</span>
                <span>{property.beds ?? 0}bd / {property.baths ?? 0}ba</span>
                <span>{property.sqft ? `${property.sqft.toLocaleString()} sqft` : 'sqft n/a'}</span>
              </div>

              <div className="dossier-property-finance">
                <div><span>Value</span><strong>{formatMoney(property.estimatedValue)}</strong></div>
                <div><span>Equity</span><strong>{formatMoney(property.equity)}</strong></div>
              </div>

              <div className="dossier-property-flags">
                {propertyFlags.map((flag) => (
                  <span key={flag} className="dossier-flag">{flag}</span>
                ))}
              </div>

              <div className="dossier-property-actions">
                <button className="dossier-btn dossier-btn--ghost">Open</button>
                <button className="dossier-btn dossier-btn--ghost">Map</button>
                <button className="dossier-btn dossier-btn--accent">Offer</button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );

  const renderConversation = () => {
    const conversation = selectedSeller?.conversations[0];

    return (
      <div className="dossier-view">
        <div className="dossier-view-grid dossier-view-grid--conversation">
          <section className="dossier-card dossier-card--summary">
            <div className="dossier-card__title">Conversation Intelligence</div>
            <div className="dossier-convo-meta">
              <span className="dossier-chip">{titleCase(conversation?.channel || 'sms')}</span>
              <span className="dossier-chip">Last contact {formatDate(conversation?.lastMessageAt)}</span>
              <span className="dossier-chip dossier-chip--sentiment">{titleCase(conversation?.sentiment || 'neutral')}</span>
              {conversation?.objection && <span className="dossier-chip dossier-chip--warning">Objection: {conversation.objection}</span>}
            </div>
            <p className="dossier-card__body">{conversation?.lastMessage || 'No messages available for this seller.'}</p>
          </section>

          <section className="dossier-card">
            <div className="dossier-card__title">AI Conversation Summary</div>
            <p className="dossier-card__body">{conversation?.aiSummary || 'Awaiting new conversation activity for summary generation.'}</p>
            <div className="dossier-next-action-box">
              <div className="dossier-next-action-box__label">Suggested Next Follow-Up</div>
              <div className="dossier-next-action-box__value">{conversation?.nextAction || selectedSeller?.nextBestAction}</div>
            </div>
          </section>

          <section className="dossier-card">
            <div className="dossier-card__title">Communication Controls</div>
            <div className="dossier-action-group">
              <button className="dossier-btn dossier-btn--accent">Open Inbox</button>
              <button className="dossier-btn dossier-btn--ghost">Queue Follow-Up</button>
              <button className="dossier-btn dossier-btn--ghost">Create Script</button>
              <button className="dossier-btn dossier-btn--ghost">Mark Objection</button>
            </div>
          </section>
        </div>
      </div>
    );
  };

  const renderMotivation = () => (
    <div className="dossier-view">
      <div className="dossier-view-grid dossier-view-grid--motivation">
        <section className="dossier-card dossier-card--metric">
          <div className="dossier-card__title">Motivation Index</div>
          <div className="dossier-big-score">{selectedSeller?.motivationScore ?? 0}</div>
          <div className="dossier-inline-meta">
            <span className="dossier-chip">AI Score {selectedSeller?.aiScore ?? 0}</span>
            <span className="dossier-chip">Conversion {conversionWindow}</span>
          </div>
        </section>

        <section className="dossier-card">
          <div className="dossier-card__title">Signal Breakdown</div>
          <div className="dossier-signal-list">
            {motivationRows.map((signal) => (
              <div key={signal.signal} className="dossier-signal-row">
                <div className="dossier-signal-row__left">
                  <div className="dossier-signal-name">{titleCase(signal.signal)}</div>
                  <div className="dossier-signal-group">{signal.group}</div>
                </div>
                <div className="dossier-signal-bar">
                  <div className="dossier-signal-bar__fill" style={{ width: `${signal.strength}%` }} />
                </div>
                <div className="dossier-signal-value">{signal.strength}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="dossier-card">
          <div className="dossier-card__title">AI Motivation Summary</div>
          <p className="dossier-card__body">
            Motivation appears {selectedSeller?.motivationScore && selectedSeller.motivationScore > 70 ? 'high' : 'moderate'} based on owner behavior, equity depth, and event timeline.
            Priority execution window is {conversionWindow} with best contact timing at {selectedSeller?.bestContactTime}.
          </p>
        </section>
      </div>
    </div>
  );

  const renderDeals = () => (
    <div className="dossier-view">
      <div className="dossier-view-grid dossier-view-grid--deals">
        <section className="dossier-card">
          <div className="dossier-card__title">Execution Center</div>
          <div className="dossier-deal-grid">
            <div className="dossier-deal-cell"><span>Lead Stage</span><strong>{titleCase(selectedSeller?.leadStage || 'prospect')}</strong></div>
            <div className="dossier-deal-cell"><span>Seller Stage</span><strong>{titleCase(selectedSeller?.sellerStage || 'no_deal')}</strong></div>
            <div className="dossier-deal-cell"><span>Offer Status</span><strong>{selectedSeller?.offerStatus || 'Not started'}</strong></div>
            <div className="dossier-deal-cell"><span>Recommended Offer</span><strong>{formatMoney(selectedSeller?.recommendedCashOffer)}</strong></div>
            <div className="dossier-deal-cell"><span>Contract Status</span><strong>{selectedSeller?.contractStatus || 'Not started'}</strong></div>
            <div className="dossier-deal-cell"><span>Title Status</span><strong>{selectedSeller?.titleStatus || 'Not started'}</strong></div>
            <div className="dossier-deal-cell"><span>Buyer Match</span><strong>{selectedSeller?.buyerMatchStatus || 'Pending'}</strong></div>
          </div>
        </section>

        <section className="dossier-card dossier-card--actions">
          <div className="dossier-card__title">Deal Actions</div>
          <div className="dossier-action-grid">
            <button className="dossier-btn dossier-btn--accent">Generate Offer</button>
            <button className="dossier-btn dossier-btn--ghost">Send Offer</button>
            <button className="dossier-btn dossier-btn--ghost">Create Contract</button>
            <button className="dossier-btn dossier-btn--ghost">Send to Title</button>
            <button className="dossier-btn dossier-btn--ghost">Open Buyer Match</button>
          </div>
        </section>
      </div>
    </div>
  );

  const renderTimeline = () => (
    <div className="dossier-view">
      <div className="dossier-timeline">
        {selectedSeller?.timeline.map((event) => (
          <article key={event.id} className={`dossier-timeline-item ${getSeverityClass(event)}`}>
            <div className="dossier-timeline-item__rail">
              <span className="dossier-timeline-item__icon">{getTimelineIcon(event.type)}</span>
              <span className="dossier-timeline-item__line" />
            </div>
            <div className="dossier-timeline-item__content">
              <div className="dossier-timeline-item__top">
                <strong>{event.label}</strong>
                <span>{formatDate(event.timestamp)}</span>
              </div>
              <div className="dossier-timeline-item__desc">{event.description}</div>
              <div className="dossier-timeline-item__meta">{titleCase(event.source)} • {titleCase(event.type)}</div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );

  return (
    <div className="dossier-page">
      <div className="dossier-header">
        <div className="dossier-header__left">
          <h1 className="dossier-header__title">Seller Dossier</h1>
          <div className="dossier-stats">
            <span className="dossier-stat"><strong>{data.stats.totalOwners}</strong> owners</span>
            <span className="dossier-stat"><strong>{data.stats.hotSellers}</strong> hot</span>
            <span className="dossier-stat"><strong>{data.stats.portfolioOwners}</strong> portfolio</span>
            <span className="dossier-stat"><strong>{data.stats.needsAction}</strong> queued</span>
          </div>
        </div>

        <div className="dossier-header__right">
          <input
            type="text"
            className="dossier-search"
            placeholder="Search owner or market"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button className="dossier-command-hint" onClick={() => setShowCommandPalette((state) => !state)}>
            Cmd K
          </button>
        </div>
      </div>

      {showCommandPalette && (
        <div className="dossier-command-palette">
          <div className="dossier-command-list">
            <div className="dossier-command-search">
              <input
                type="text"
                placeholder="Search commands"
                value={commandSearch}
                onChange={(event) => setCommandSearch(event.target.value)}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setShowCommandPalette(false);
                    setCommandSearch('');
                  }
                }}
              />
            </div>
            <div className="dossier-command-scroll">
              {Object.entries(groupedCommands).map(([category, commands]) => (
                <div key={category} className="dossier-command-group">
                  <div className="dossier-command-category">{category}</div>
                  {commands.map((command) => (
                    <div
                      key={command.label}
                      className="dossier-command-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => handleCommandSelect(command)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') handleCommandSelect(command);
                      }}
                    >
                      <div className="dossier-command-item__content">
                        <div className="dossier-command-item__label">{command.label}</div>
                        <div className="dossier-command-item__description">{command.description}</div>
                      </div>
                      {command.shortcut && <div className="dossier-command-item__shortcut">{command.shortcut}</div>}
                    </div>
                  ))}
                </div>
              ))}
              {filteredCommands.length === 0 && <div className="dossier-command-empty">No commands found</div>}
            </div>
          </div>
        </div>
      )}

      <div className="dossier-filters">
        <button
          className={`dossier-filter-chip ${filters.temperature === 'hot' ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, temperature: filters.temperature === 'hot' ? undefined : 'hot' })}
        >
          Hot
        </button>
        <button
          className={`dossier-filter-chip ${filters.temperature === 'warm' ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, temperature: filters.temperature === 'warm' ? undefined : 'warm' })}
        >
          Warm
        </button>
        <button
          className={`dossier-filter-chip ${filters.highEquity ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, highEquity: !filters.highEquity })}
        >
          High Equity
        </button>
        <button
          className={`dossier-filter-chip ${filters.hasDistress ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, hasDistress: !filters.hasDistress })}
        >
          Distress
        </button>
        <button
          className={`dossier-filter-chip ${filters.corporate ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, corporate: !filters.corporate })}
        >
          Corporate
        </button>
        <button
          className={`dossier-filter-chip ${filters.outOfState ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, outOfState: !filters.outOfState })}
        >
          Out of State
        </button>
        <button
          className={`dossier-filter-chip ${filters.portfolioOwners ? 'dossier-filter-chip--active' : ''}`}
          onClick={() => setFilters({ ...filters, portfolioOwners: !filters.portfolioOwners })}
        >
          Portfolio Owners
        </button>
      </div>

      <div className="dossier-workspace">
        <aside className="dossier-column dossier-column--left">
          <div className="dossier-owner-list">
            {filteredSellers.map((seller) => (
              <article
                key={seller.id}
                className={`dossier-owner-card ${selectedSeller?.id === seller.id ? 'dossier-owner-card--selected' : ''}`}
                onClick={() => {
                  setSelectedSeller(seller);
                  setSelectedProperty(null);
                }}
              >
                <div className="dossier-owner-card__top">
                  <div className="dossier-owner-card__name">{seller.displayName}</div>
                  <span className={getTemperatureClass(seller.temperature)}>{seller.temperature}</span>
                </div>
                <div className="dossier-owner-card__sub">{seller.market}</div>
                <div className="dossier-owner-card__metrics">
                  <span>{seller.propertyCount} properties</span>
                  <span>AI {seller.aiScore}</span>
                </div>
                <div className="dossier-owner-card__last">Last activity {formatDate(seller.conversations[0]?.lastMessageAt)}</div>
              </article>
            ))}
          </div>
        </aside>

        <main className="dossier-column dossier-column--center">
          {selectedSeller && (
            <>
              <section className="dossier-hero">
                <div className="dossier-hero__head">
                  <div>
                    <h2 className="dossier-hero__title">{selectedSeller.displayName}</h2>
                    <div className="dossier-hero__subtitle">
                      {selectedSeller.entityName || selectedSeller.ownerAddress} • Last activity {formatDate(sellerLastActivity)}
                    </div>
                    <div className="dossier-hero__badges">
                      <span className="dossier-badge">{titleCase(selectedSeller.ownerType)}</span>
                      <span className="dossier-badge">{selectedSeller.market}</span>
                      <span className={`dossier-badge dossier-badge--heat dossier-badge--${selectedSeller.temperature}`}>{titleCase(selectedSeller.temperature)}</span>
                    </div>
                  </div>

                  <div className="dossier-hero__nba">
                    <div className="dossier-hero__nba-label">Next Best Action</div>
                    <div className="dossier-hero__nba-value">{selectedSeller.nextBestAction}</div>
                    <div className="dossier-hero__nba-reason">{selectedSeller.nextBestActionReason}</div>
                  </div>
                </div>

                <div className="dossier-kpi-strip">
                  <div className="dossier-kpi-card"><span>AI Score</span><strong>{selectedSeller.aiScore}</strong></div>
                  <div className="dossier-kpi-card"><span>Motivation</span><strong>{selectedSeller.motivationScore}</strong></div>
                  <div className="dossier-kpi-card"><span>Contact Probability</span><strong>{selectedSeller.contactProbability}%</strong></div>
                  <div className="dossier-kpi-card"><span>Portfolio Value</span><strong>{formatMoney(selectedSeller.portfolioValue)}</strong></div>
                  <div className="dossier-kpi-card"><span>Total Equity</span><strong>{formatMoney(selectedSeller.estimatedEquity)}</strong></div>
                  <div className="dossier-kpi-card"><span>Property Count</span><strong>{selectedSeller.propertyCount}</strong></div>
                </div>
              </section>

              <nav className="dossier-tabs">
                {DOSSIER_VIEWS.map((view, index) => (
                  <button
                    key={view}
                    className={`dossier-tab ${activeView === view ? 'dossier-tab--active' : ''}`}
                    onClick={() => setActiveView(view)}
                  >
                    <span>{titleCase(view)}</span>
                    <small>{index + 1}</small>
                  </button>
                ))}
              </nav>

              {activeView === 'overview' && renderOverview()}
              {activeView === 'properties' && renderProperties()}
              {activeView === 'conversation' && renderConversation()}
              {activeView === 'motivation' && renderMotivation()}
              {activeView === 'deals' && renderDeals()}
              {activeView === 'timeline' && renderTimeline()}
            </>
          )}
        </main>

        <aside className="dossier-column dossier-column--right">
          {selectedSeller && !selectedProperty && (
            <div className="dossier-operator-rail">
              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">Identity</div>
                <div className="dossier-operator-row"><span>Owner Type</span><strong>{titleCase(selectedSeller.ownerType)}</strong></div>
                <div className="dossier-operator-row"><span>Address</span><strong>{selectedSeller.ownerAddress}</strong></div>
                <div className="dossier-operator-row"><span>Market</span><strong>{selectedSeller.market}</strong></div>
                <div className="dossier-operator-row"><span>Language</span><strong>{selectedSeller.language}</strong></div>
              </section>

              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">Contact Stack</div>
                {selectedSeller.phones.slice(0, 3).map((phone) => (
                  <div key={phone.id} className="dossier-operator-row">
                    <span>{titleCase(phone.type)}</span>
                    <strong>{phone.phone}</strong>
                  </div>
                ))}
                {selectedSeller.emails.slice(0, 2).map((email) => (
                  <div key={email.id} className="dossier-operator-row">
                    <span>Email</span>
                    <strong>{email.email}</strong>
                  </div>
                ))}
              </section>

              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">AI Recommendation</div>
                <p className="dossier-operator-copy">{selectedSeller.nextBestActionReason}</p>
                <div className="dossier-operator-row"><span>Confidence</span><strong>{selectedSeller.aiConfidence}%</strong></div>
                <div className="dossier-operator-row"><span>Risk Score</span><strong>{selectedSeller.riskScore}</strong></div>
              </section>

              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">Quick Actions</div>
                <div className="dossier-action-stack">
                  <button className="dossier-btn dossier-btn--accent">Open Inbox</button>
                  <button className="dossier-btn dossier-btn--ghost">Schedule Follow-Up</button>
                  <button className="dossier-btn dossier-btn--ghost">Generate Offer</button>
                  <button className="dossier-btn dossier-btn--ghost">Mark Hot</button>
                  <button className="dossier-btn dossier-btn--ghost">Add Note</button>
                </div>
              </section>
            </div>
          )}

          {selectedProperty && (
            <div className="dossier-operator-rail">
              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">Property Intelligence</div>
                <div className="dossier-operator-row"><span>Address</span><strong>{selectedProperty.address}</strong></div>
                <div className="dossier-operator-row"><span>Type</span><strong>{titleCase(selectedProperty.propertyType)}</strong></div>
                <div className="dossier-operator-row"><span>Estimated Value</span><strong>{formatMoney(selectedProperty.estimatedValue)}</strong></div>
                <div className="dossier-operator-row"><span>Estimated Equity</span><strong>{formatMoney(selectedProperty.equity)}</strong></div>
                <div className="dossier-operator-row"><span>Recommended Strategy</span><strong>{selectedProperty.recommendedStrategy}</strong></div>
              </section>
              <section className="dossier-operator-card">
                <div className="dossier-operator-card__title">Property Actions</div>
                <div className="dossier-action-stack">
                  <button className="dossier-btn dossier-btn--accent">Open Property</button>
                  <button className="dossier-btn dossier-btn--ghost">Generate Offer</button>
                  <button className="dossier-btn dossier-btn--ghost">Map Focus</button>
                  <button className="dossier-btn dossier-btn--ghost" onClick={() => setSelectedProperty(null)}>Back to Seller</button>
                </div>
              </section>
            </div>
          )}

          {!selectedSeller && <div className="dossier-inspector--empty">Select an owner to view details</div>}
        </aside>
      </div>
    </div>
  );
};
