import type { SellerDossier, DossierModel, Phone, Email, Property, ConversationThread, TimelineEvent } from './dossier.types';
import { fetchDossierModel } from '../../lib/data/sellerData';
import { isDev, shouldUseSupabase } from '../../lib/data/shared';

const MARKETS = ['Austin TX', 'Dallas TX', 'Houston TX', 'Denver CO', 'Phoenix AZ', 'Las Vegas NV', 'Jacksonville FL'];
const FIRST_NAMES = ['Robert', 'Margaret', 'James', 'John', 'Sarah', 'Michael', 'Patricia', 'David', 'Jennifer', 'Richard'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const ENTITY_NAMES = ['Capital Partners LLC', 'Phoenix Holdings', 'Premier Property Management', 'Equity Realty Corp', 'Strategic Investments LLC'];

const PROPERTY_ADDRESSES = [
  '1247 Oak Ridge Drive',
  '4532 Maple Lane',
  '789 Cedar Street',
  '2156 Birch Avenue',
  '6543 Elm Court',
  '3890 Spruce Road',
  '1122 Willow Drive',
  '5678 Ash Boulevard',
];

const PROPERTY_CITIES = ['Austin', 'Dallas', 'Houston', 'Denver', 'Phoenix', 'Scottsdale', 'Las Vegas', 'Jacksonville'];

function generatePhone(): Phone {
  const areaCode = Math.floor(200 + Math.random() * 700);
  const prefix = Math.floor(100 + Math.random() * 900);
  const lineNum = Math.floor(1000 + Math.random() * 9000);
  return {
    id: `phone_${Math.random().toString(36).substr(2, 9)}`,
    phone: `${areaCode}${prefix}${lineNum}`,
    type: ['mobile', 'landline', 'business'][Math.floor(Math.random() * 3)] as any,
    status: Math.random() > 0.2 ? 'verified' : 'unverified',
    carrier: ['AT&T', 'Verizon', 'T-Mobile', 'Sprint'][Math.floor(Math.random() * 4)],
    dncStatus: Math.random() > 0.85 ? 'dnc' : 'active',
    confidence: Math.floor(70 + Math.random() * 30),
    lastContacted: `2024-${String(Math.floor(1 + Math.random() * 4)).padStart(2, '0')}-${String(Math.floor(1 + Math.random() * 28)).padStart(2, '0')}`,
  };
}

function generateEmail(): Email {
  const user = Math.random().toString(36).substring(7);
  return {
    id: `email_${Math.random().toString(36).substr(2, 9)}`,
    email: `${user}@example.com`,
    role: ['owner', 'primary', 'secondary', 'business'][Math.floor(Math.random() * 4)],
    status: Math.random() > 0.15 ? 'verified' : 'unverified',
    confidence: Math.floor(60 + Math.random() * 40),
    language: Math.random() > 0.9 ? 'spanish' : 'english',
  };
}

function generateProperty(index: number): Property {
  const equity = Math.floor(50000 + Math.random() * 500000);
  const value = equity + Math.floor(100000 + Math.random() * 400000);
  const distressSignals = [];
  if (Math.random() > 0.7) distressSignals.push('vacant');
  if (Math.random() > 0.8) distressSignals.push('tax_delinquent');
  if (Math.random() > 0.85) distressSignals.push('foreclosure');
  if (Math.random() > 0.8) distressSignals.push('absentee');
  if (Math.random() > 0.75) distressSignals.push('tired_landlord');

  return {
    propertyId: `prop_${Math.random().toString(36).substr(2, 9)}`,
    address: PROPERTY_ADDRESSES[index % PROPERTY_ADDRESSES.length],
    city: PROPERTY_CITIES[index % PROPERTY_CITIES.length],
    state: ['TX', 'CO', 'AZ', 'NV', 'FL'][index % 5],
    zip: String(75000 + index).slice(0, 5),
    propertyType: ['single_family', 'multifamily', 'commercial', 'land'][Math.floor(Math.random() * 4)] as any,
    beds: Math.floor(1 + Math.random() * 6),
    baths: Math.floor(1 + Math.random() * 4),
    sqft: Math.floor(1000 + Math.random() * 6000),
    yearBuilt: Math.floor(1980 + Math.random() * 40),
    estimatedValue: value,
    equity: equity,
    mortgageBalance: value - equity,
    absentee: Math.random() > 0.6,
    vacant: Math.random() > 0.8,
    taxDelinquent: Math.random() > 0.85,
    probate: Math.random() > 0.9,
    foreclosure: Math.random() > 0.88,
    freeAndClear: equity === value,
    highEquity: equity > value * 0.7,
    tiredLandlord: Math.random() > 0.75,
    distressSignals: distressSignals as any,
    aiPropertyScore: Math.floor(40 + Math.random() * 60),
    recommendedStrategy: ['wholesale', 'lease_option', 'cash_offer', 'creative_structure'][Math.floor(Math.random() * 4)],
  };
}

function generateConversation(): ConversationThread {
  return {
    threadId: `thread_${Math.random().toString(36).substr(2, 9)}`,
    channel: ['sms', 'email', 'phone'][Math.floor(Math.random() * 3)] as any,
    lastMessage: 'Interested in learning more about your property options...',
    lastMessageAt: `2024-${String(Math.floor(1 + Math.random() * 4)).padStart(2, '0')}-${String(Math.floor(1 + Math.random() * 28)).padStart(2, '0')}`,
    sentiment: ['positive', 'neutral', 'interested'][Math.floor(Math.random() * 3)] as any,
    objection: Math.random() > 0.7 ? 'Price too low' : undefined,
    stage: ['prospect', 'contacted', 'engaged', 'negotiating'][Math.floor(Math.random() * 4)] as any,
    nextAction: 'Schedule callback',
    aiSummary: 'Owner shows moderate interest in wholesale transaction. Primary concern is pricing and timeline.',
  };
}

function generateTimelineEvent(index: number): TimelineEvent {
  const eventTypes = [
    { label: 'Owner imported', type: 'import', severity: 'low' },
    { label: 'Property linked', type: 'property_link', severity: 'low' },
    { label: 'Phone verified', type: 'verification', severity: 'medium' },
    { label: 'First SMS sent', type: 'outreach', severity: 'medium' },
    { label: 'Seller replied', type: 'inbound', severity: 'high' },
    { label: 'Objection detected', type: 'objection', severity: 'medium' },
    { label: 'AI draft generated', type: 'ai_action', severity: 'low' },
    { label: 'Follow-up queued', type: 'queue', severity: 'low' },
  ];
  const event = eventTypes[index % eventTypes.length];
  return {
    id: `event_${Math.random().toString(36).substr(2, 9)}`,
    type: event.type,
    label: event.label,
    timestamp: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
    source: 'system',
    description: `${event.label} for this owner`,
    severity: event.severity as any,
  };
}

function generateSellerDossier(index: number): SellerDossier {
  const isHot = Math.random() > 0.85;
  const isCorporate = Math.random() > 0.8;
  const isOutOfState = Math.random() > 0.75;
  const propertyCount = Math.floor(1 + Math.random() * 8);

  return {
    id: `seller_${Math.random().toString(36).substr(2, 9)}`,
    masterOwnerId: `owner_${index}`,
    masterKey: `KEY_${index}`,
    displayName: `${FIRST_NAMES[index % FIRST_NAMES.length]} ${LAST_NAMES[index % LAST_NAMES.length]}`,
    firstName: FIRST_NAMES[index % FIRST_NAMES.length],
    lastName: LAST_NAMES[index % LAST_NAMES.length],
    entityName: isCorporate ? ENTITY_NAMES[index % ENTITY_NAMES.length] : undefined,
    ownerType: isCorporate ? 'corporation' : 'individual',
    ownerAddress: PROPERTY_ADDRESSES[index % PROPERTY_ADDRESSES.length],
    mailingCity: PROPERTY_CITIES[index % PROPERTY_CITIES.length],
    mailingState: ['TX', 'CO', 'AZ', 'NV', 'FL'][index % 5],
    mailingZip: String(75000 + index).slice(0, 5),
    outOfStateOwner: isOutOfState,
    corporateOwner: isCorporate,
    trustEstate: Math.random() > 0.9,
    hedgeFundMatch: Math.random() > 0.92,
    language: Math.random() > 0.95 ? 'spanish' : 'english',
    contactProbability: Math.floor(40 + Math.random() * 60),
    preferredChannel: ['sms', 'email', 'phone'][Math.floor(Math.random() * 3)] as any,
    bestContactTime: ['morning', 'afternoon', 'evening'][Math.floor(Math.random() * 3)],
    market: MARKETS[index % MARKETS.length],
    status: 'active',
    temperature: isHot ? 'hot' : Math.random() > 0.4 ? 'warm' : 'cold',
    priority: isHot ? 'high' : Math.random() > 0.5 ? 'medium' : 'low',
    aiScore: isHot ? Math.floor(75 + Math.random() * 25) : Math.floor(30 + Math.random() * 70),
    motivationScore: Math.floor(20 + Math.random() * 80),
    riskScore: Math.floor(10 + Math.random() * 60),
    portfolioValue: propertyCount * (200000 + Math.random() * 300000),
    estimatedEquity: propertyCount * (50000 + Math.random() * 150000),
    propertyCount: propertyCount,
    linkedProspectsCount: Math.floor(1 + Math.random() * 5),
    linkedPhoneCount: Math.floor(1 + Math.random() * 3),
    linkedEmailCount: Math.floor(0 + Math.random() * 3),
    phones: Array.from({ length: Math.floor(1 + Math.random() * 2) }, () => generatePhone()),
    emails: Array.from({ length: Math.floor(0 + Math.random() * 2) }, () => generateEmail()),
    properties: Array.from({ length: propertyCount }, (_, i) => generateProperty(index * 10 + i)),
    conversations: Array.from({ length: Math.floor(1 + Math.random() * 2) }, () => generateConversation()),
    timeline: Array.from({ length: 6 }, (_, i) => generateTimelineEvent(i)),
    leadStage: ['prospect', 'contacted', 'engaged'][Math.floor(Math.random() * 3)] as any,
    sellerStage: ['no_deal', 'preliminary', 'offer_generated'][Math.floor(Math.random() * 3)] as any,
    askingPrice: Math.random() > 0.6 ? Math.floor(300000 + Math.random() * 700000) : undefined,
    offerStatus: 'none',
    recommendedCashOffer: Math.floor(200000 + Math.random() * 500000),
    creativeOfferEligible: Math.random() > 0.5,
    multifamilyUnderwriteRequired: Math.random() > 0.8,
    contractStatus: 'none',
    titleStatus: 'clear',
    closingStatus: 'none',
    buyerMatchStatus: 'pending',
    nextBestAction: ['Send SMS', 'Schedule call', 'Generate offer', 'Open inventory'][Math.floor(Math.random() * 4)],
    nextBestActionReason: 'Based on owner motivation and property profile',
    aiConfidence: Math.floor(65 + Math.random() * 35),
  };
}

export async function loadDossier(): Promise<DossierModel> {
  if (shouldUseSupabase()) {
    try {
      return await fetchDossierModel();
    } catch (error) {
      if (isDev) {
        console.warn('[NEXUS] Dossier Supabase load failed, using generated model.', error);
      }
    }
  }

  // Simulate async loader
  await new Promise((resolve) => setTimeout(resolve, 100));

  const sellers = Array.from({ length: 24 }, (_, i) => generateSellerDossier(i));

  const hotCount = sellers.filter((s) => s.temperature === 'hot').length;
  const portfolioCount = sellers.filter((s) => s.propertyCount > 3).length;
  const needsAction = sellers.filter((s) => s.priority === 'high').length;
  const avgMotivation = Math.round(sellers.reduce((sum, s) => sum + s.motivationScore, 0) / sellers.length);

  return {
    sellers,
    stats: {
      totalOwners: sellers.length,
      hotSellers: hotCount,
      portfolioOwners: portfolioCount,
      needsAction: needsAction,
      averageMotivationScore: avgMotivation,
    },
  };
}
