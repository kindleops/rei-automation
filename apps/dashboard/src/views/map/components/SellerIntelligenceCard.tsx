import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getThreadMessages, type ThreadMessage } from '../../../lib/data/inboxData'
import { buildStreetViewUrl } from '../inbox-normalization'
import '../seller-intelligence-card.css'
import '../map-intelligence-cards.css'

type SellerRecord = Record<string, unknown>
type DensityMode = 'compact' | 'balanced' | 'expanded' | 'full'
type LayoutMode = 'compact' | 'medium' | 'expanded' | 'full'
type PillTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral'

type SellerStatusPill = {
  label: string
  tone: PillTone
}

type MetricItem = {
  label: string
  value: string
}

type SellerIntelligenceCardProps = {
  record: SellerRecord | null
  layoutMode?: LayoutMode
  variant?: 'hover' | 'selected'
  messages?: ThreadMessage[]
  loading?: boolean
  draftText?: string
  disabled?: boolean
  onDraftChange?: (value: string) => void
  onSend?: () => void
  onClose?: () => void
  onOpenDealIntelligence?: () => void
  onOpenConversation?: () => void
}

const cls = (...tokens: Array<string | false | null | undefined>) => tokens.filter(Boolean).join(' ')
const normalize = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => normalize(value).toLowerCase()

const firstDefined = (record: SellerRecord, keys: string[]): unknown => {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && normalize(value) !== '') return value
  }
  return undefined
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const cleaned = normalize(value).replace(/[^0-9.-]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value
  const normalized = lower(value)
  if (!normalized) return null
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return null
}

const titleize = (value: string): string =>
  value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())

const formatNumber = (value: unknown): string => {
  const numeric = asNumber(value)
  return numeric === null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(numeric)
}

const formatMoney = (value: unknown): string => {
  const numeric = asNumber(value)
  if (numeric === null) return '—'
  if (numeric >= 1000000) return `$${(numeric / 1000000).toFixed(numeric >= 10000000 ? 1 : 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}M`
  if (numeric >= 1000) return `$${(numeric / 1000).toFixed(numeric >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(numeric)
}

const formatDate = (value: unknown): string => {
  const raw = normalize(value)
  if (!raw) return '—'
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).format(parsed)
}

const formatRelativeTime = (value: unknown): string => {
  const raw = normalize(value)
  if (!raw) return ''
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return ''
  const diffMinutes = Math.floor((Date.now() - parsed.getTime()) / 60000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return formatDate(raw)
}

const parseTagValues = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => parseTagValues(entry))
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap((entry) => parseTagValues(entry))
  const raw = normalize(value)
  if (!raw) return []
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      return parseTagValues(JSON.parse(raw))
    } catch {
      return raw.split(/[;,|]/).map((entry) => entry.trim()).filter(Boolean)
    }
  }
  return raw.split(/[;,|]/).map((entry) => entry.trim()).filter(Boolean)
}

const resolveDensityMode = (layoutMode: LayoutMode): DensityMode => {
  if (layoutMode === 'compact') return 'compact'
  if (layoutMode === 'medium') return 'balanced'
  if (layoutMode === 'expanded') return 'expanded'
  return 'full'
}

export const deriveOwnerType = (record: SellerRecord): string => {
  const raw = lower(firstDefined(record, ['owner_type', 'ownerType', 'owner_type_label']))
  if (raw.includes('hedge fund') || raw.includes('institutional')) return 'Hedge Fund'
  if (raw.includes('trust') || raw.includes('estate')) return 'Trust / Estate'
  if (raw.includes('bank') || raw.includes('lender')) return 'Bank / Lender'
  if (raw.includes('government')) return 'Government'
  if (raw.includes('corporate') || raw.includes('llc') || raw.includes('corp') || raw.includes('company')) return 'Corporate'
  if (raw.includes('individual')) return 'Individual'
  if (asBoolean(firstDefined(record, ['is_corporate_owner', 'corporate_owner'])) === true) return 'Corporate'
  if (asBoolean(firstDefined(record, ['is_corporate_owner', 'corporate_owner'])) === false) return 'Individual'
  return 'Needs Review'
}

const hasReply = (record: SellerRecord, messages: ThreadMessage[]): boolean => {
  const explicit = normalize(firstDefined(record, ['last_reply_at', 'lastReplyAt', 'last_inbound_at', 'lastInboundAt']))
  if (explicit) return true
  const replyStatus = lower(firstDefined(record, ['reply_status', 'replyStatus', 'inbox_bucket', 'inboxBucket']))
  if (replyStatus.includes('replied') || replyStatus.includes('new_reply')) return true
  return messages.some((message) => message.direction === 'inbound' && normalize(message.body))
}

const hasOwnershipConfirmation = (record: SellerRecord, messages: ThreadMessage[]): boolean => {
  if (!hasReply(record, messages)) return false
  const blob = lower([
    firstDefined(record, ['reply_status', 'replyStatus']),
    firstDefined(record, ['last_intent', 'lastIntent']),
    firstDefined(record, ['latest_message_body', 'latestMessageBody', 'last_message', 'lastMessageBody']),
    ...messages.filter((message) => message.direction === 'inbound').map((message) => message.body),
  ].filter(Boolean).join(' '))
  return /\byes\b|\bi own\b|\bstill own\b|\bowner\b|\bmy property\b/.test(blob)
}

export const deriveSellerStatusPills = (record: SellerRecord, messages: ThreadMessage[]): SellerStatusPill[] => {
  const pills: SellerStatusPill[] = []
  const contactStatus = lower(firstDefined(record, ['contact_status', 'suppression_status', 'suppressionStatus', 'status']))
  const automation = lower(firstDefined(record, ['automation_status', 'automationStatus', 'automationState']))
  const stage = lower(firstDefined(record, ['seller_stage', 'pipeline_stage', 'conversation_stage', 'conversationStage', 'stage']))
  const reply = hasReply(record, messages)

  if (contactStatus.includes('suppressed')) return [{ label: 'Suppressed', tone: 'danger' }]
  if (contactStatus.includes('opt') && contactStatus.includes('out')) return [{ label: 'Opt-Out', tone: 'danger' }]
  if (contactStatus.includes('dnc')) return [{ label: 'DNC', tone: 'danger' }]

  if (reply) pills.push({ label: 'New Reply', tone: 'accent' })
  else if (stage.includes('ownership')) pills.push({ label: 'Ownership Check Sent', tone: 'warning' })
  else if (normalize(firstDefined(record, ['last_outbound_at', 'lastOutboundAt', 'last_contact_at', 'lastContactAt']))) pills.push({ label: 'Outreach Sent', tone: 'accent' })
  else pills.push({ label: 'No Reply Yet', tone: 'neutral' })

  if (hasOwnershipConfirmation(record, messages)) {
    pills.push({ label: 'Ownership Confirmed', tone: 'success' })
  } else if (!reply) {
    pills.push({ label: 'Awaiting Response', tone: 'neutral' })
  }

  if (reply) {
    const lastReply = firstDefined(record, ['last_reply_at', 'lastReplyAt', 'last_inbound_at', 'lastInboundAt'])
    const relative = formatRelativeTime(lastReply)
    if (relative) pills.push({ label: `Last Reply ${relative}`, tone: 'accent' })
  }

  if (automation.includes('block')) pills.push({ label: 'Auto Blocked', tone: 'danger' })
  else if (automation.includes('pause')) pills.push({ label: 'Paused', tone: 'warning' })
  else if (automation.includes('active')) pills.push({ label: 'Automation Active', tone: 'success' })

  return pills.slice(0, 4)
}

export const deriveMotivationTier = (score: number | null): string => {
  if (score === null) return 'Needs Data'
  if (score <= 30) return 'Low'
  if (score <= 55) return 'Watchlist'
  if (score <= 75) return 'Moderate'
  if (score <= 90) return 'Strong'
  return 'Urgent'
}

const priorityTags = [
  'High Equity',
  'Free And Clear',
  'Tax Delinquent',
  'Absentee Owner',
  'Out Of State Owner',
  'Vacant',
  'Tired Landlord',
  'Likely To Move',
  'Probate',
  'Active Lien',
  'Senior Owner',
  'Corporate Owner',
  'Multifamily',
]

export const getTopPropertyTags = (record: SellerRecord): string[] => {
  const baseTags = [
    ...parseTagValues(firstDefined(record, ['property_flags_json'])),
    ...parseTagValues(firstDefined(record, ['property_flags_text'])),
    ...parseTagValues(firstDefined(record, ['seller_tags_text'])),
    ...parseTagValues(firstDefined(record, ['seller_tags_json'])),
    ...parseTagValues(firstDefined(record, ['podio_tags'])),
  ].map(titleize)

  const tags = new Set(baseTags)
  const ownerType = deriveOwnerType(record)
  const equity = asNumber(firstDefined(record, ['equity_percent', 'equityPercent'])) ?? 0
  if (equity >= 65) tags.add('High Equity')
  if (equity >= 95) tags.add('Free And Clear')
  if (asBoolean(firstDefined(record, ['tax_delinquent'])) === true) tags.add('Tax Delinquent')
  if (asBoolean(firstDefined(record, ['absentee_owner'])) === true) tags.add('Absentee Owner')
  if (asBoolean(firstDefined(record, ['out_of_state_owner'])) === true) tags.add('Out Of State Owner')
  if (asBoolean(firstDefined(record, ['active_lien'])) === true) tags.add('Active Lien')
  if (ownerType === 'Corporate') tags.add('Corporate Owner')
  const propertyType = lower(firstDefined(record, ['property_type', 'propertyType', 'property_class', 'propertyClass']))
  if (propertyType.includes('multi') || (asNumber(firstDefined(record, ['units_count', 'units'])) ?? 0) > 1) tags.add('Multifamily')

  return Array.from(tags).sort((left, right) => {
    const leftIndex = priorityTags.indexOf(left)
    const rightIndex = priorityTags.indexOf(right)
    if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex >= 0 ? leftIndex : 999) - (rightIndex >= 0 ? rightIndex : 999)
    return left.localeCompare(right)
  })
}

export const getNormalizedPropertyImages = (record: SellerRecord) => {
  const payload = record.raw_payload_json as Record<string, any> | undefined

  let streetViewImage: string | null = normalize(firstDefined(record, ['streetViewImage', 'streetview_image', 'street_view_image'])) || null
  if (!streetViewImage && payload?.streetview_image) {
    streetViewImage = normalize(payload.streetview_image)
  }

  if (!streetViewImage) {
    const address = normalize(firstDefined(record, [
      'property_address_full',
      'propertyAddressFull',
      'property_address',
      'propertyAddress',
      'address',
      'situs_address',
    ]))
    if (address && address !== 'Property Unknown') {
      streetViewImage = buildStreetViewUrl(address) || null
    }
  }

  const mapImage = normalize(firstDefined(record, ['mapImage', 'map_image'])) || null
  const satelliteImage = normalize(firstDefined(record, ['satelliteImage', 'satellite_image'])) || null

  return {
    streetViewImage: streetViewImage || null,
    mapImage,
    satelliteImage,
  }
}

export const buildSellerPhysicalStats = (record: SellerRecord): string[] => {
  const parts: string[] = []
  const beds = formatNumber(firstDefined(record, ['total_bedrooms', 'beds', 'bedrooms']))
  const baths = formatNumber(firstDefined(record, ['total_baths', 'baths', 'bathrooms']))
  const sqft = formatNumber(firstDefined(record, ['building_square_feet', 'sqft', 'livingAreaSqft']))
  const units = formatNumber(firstDefined(record, ['units_count', 'units', 'unit_count']))
  const yearBuilt = formatNumber(firstDefined(record, ['year_built', 'effective_year_built', 'yearBuilt']))
  const acreage = asNumber(firstDefined(record, ['lot_acreage']))
  const lotSquareFeet = asNumber(firstDefined(record, ['lot_square_feet']))

  if (beds !== '—') parts.push(`${beds} bd`)
  if (baths !== '—') parts.push(`${baths} ba`)
  if (sqft !== '—') parts.push(`${sqft} sqft`)
  if (units !== '—') parts.push(`${units} unit${units === '1' ? '' : 's'}`)
  if (yearBuilt !== '—') parts.push(`Built ${yearBuilt}`)
  if (acreage !== null && acreage > 0) parts.push(`${acreage.toFixed(2)} ac`)
  else if (lotSquareFeet !== null && lotSquareFeet > 0) parts.push(`${formatNumber(lotSquareFeet)} sf lot`)
  return parts
}

export const buildSellerFinancialStats = (record: SellerRecord): string[] => {
  const parts: string[] = []
  const estimatedValue = formatMoney(firstDefined(record, ['estimated_value', 'estimatedValue']))
  const repairs = formatMoney(firstDefined(record, ['estimated_repair_cost', 'estimatedRepairCost', 'repair_estimate']))
  const equity = formatPercent(firstDefined(record, ['equity_percent', 'equityPercent']))
  if (estimatedValue !== '—') parts.push(`Value ${estimatedValue}`)
  if (repairs !== '—') parts.push(`Repairs ${repairs}`)
  if (equity !== '—') parts.push(`Equity ${equity}`)
  return parts
}

const formatPercent = (value: unknown): string => {
  const numeric = asNumber(value)
  return numeric === null ? '—' : `${Math.round(numeric)}%`
}

const StatusPill = ({ pill }: { pill: SellerStatusPill }) => (
  <span className={cls('nx-seller-card__pill', `is-${pill.tone}`)}>{pill.label}</span>
)

const isMultifamilyAsset = (record: SellerRecord): boolean => {
  const propertyType = lower(firstDefined(record, ['property_type', 'propertyType', 'property_class', 'propertyClass']))
  const units = asNumber(firstDefined(record, ['units_count', 'units', 'unit_count'])) ?? 0
  return units > 1 || propertyType.includes('multi') || propertyType.includes('apartment')
}

const buildCompactPhysicalSummary = (record: SellerRecord): string[] => {
  const parts: string[] = []
  const isMultifamily = isMultifamilyAsset(record)
  const beds = formatNumber(firstDefined(record, ['total_bedrooms', 'beds', 'bedrooms']))
  const baths = formatNumber(firstDefined(record, ['total_baths', 'baths', 'bathrooms']))
  const sqftNumber = asNumber(firstDefined(record, ['building_square_feet', 'sqft', 'livingAreaSqft']))
  const sqft = sqftNumber === null ? '—' : formatNumber(sqftNumber)
  const unitsNumber = asNumber(firstDefined(record, ['units_count', 'units', 'unit_count']))
  const yearBuilt = formatNumber(firstDefined(record, ['year_built', 'effective_year_built', 'yearBuilt']))
  const acreage = asNumber(firstDefined(record, ['lot_acreage']))
  const lotSquareFeet = asNumber(firstDefined(record, ['lot_square_feet']))

  if (isMultifamily) {
    if (unitsNumber !== null && unitsNumber > 1) parts.push(`${formatNumber(unitsNumber)} units`)
    if (sqft !== '—') parts.push(`${sqft} sqft`)
    if (sqftNumber !== null && unitsNumber !== null && unitsNumber > 1) {
      parts.push(`${formatNumber(sqftNumber / unitsNumber)} sqft/unit`)
    }
  } else {
    if (beds !== '—') parts.push(`${beds} bd`)
    if (baths !== '—') parts.push(`${baths} ba`)
    if (sqft !== '—') parts.push(`${sqft} sqft`)
  }

  if (yearBuilt !== '—') parts.push(`Built ${yearBuilt}`)
  if (acreage !== null && acreage > 0) parts.push(`${acreage.toFixed(2)} ac`)
  else if (lotSquareFeet !== null && lotSquareFeet > 0) parts.push(`${formatNumber(lotSquareFeet)} sf lot`)
  return parts
}

const buildOwnershipMeta = (record: SellerRecord): string[] => {
  const parts: string[] = []
  const ownershipYears = formatNumber(firstDefined(record, ['ownership_years', 'ownershipYears']))
  const lastSale = formatDate(firstDefined(record, ['last_sale_date', 'lastSaleDate', 'sale_date', 'saleDate']))
  if (ownershipYears !== '—') parts.push(`${ownershipYears} yrs owned`)
  if (lastSale !== '—') parts.push(`Last Sale ${lastSale}`)
  return parts
}

const buildCompactStatusItems = (record: SellerRecord, messages: ThreadMessage[]): string[] => {
  const items: string[] = []
  const pills = deriveSellerStatusPills(record, messages)
  for (const pill of pills) {
    if (!items.includes(pill.label)) items.push(pill.label)
    if (items.length >= 2) break
  }
  return items
}

const smsDeliveryClass = (status: string): string => {
  const s = status.toLowerCase()
  if (s === 'delivered') return 'nx-seller-card__sms-delivery--delivered'
  if (s === 'sent') return 'nx-seller-card__sms-delivery--sent'
  if (s === 'failed') return 'nx-seller-card__sms-delivery--failed'
  if (s === 'queued' || s === 'approval') return 'nx-seller-card__sms-delivery--queued'
  return ''
}

const smsFmtTime = (iso: string | undefined): string => {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export function SellerIntelligenceCard({
  record,
  layoutMode = 'full',
  variant = 'hover',
  messages = [],
  loading = false,
  draftText = '',
  disabled = false,
  onDraftChange,
  onSend,
  onClose,
  onOpenDealIntelligence,
  onOpenConversation,
}: SellerIntelligenceCardProps) {
  if (!record) return null

  const [isSmsFlipped, setIsSmsFlipped] = useState(false)
  const [smsMessages, setSmsMessages] = useState<ThreadMessage[]>([])
  const [smsLoading, setSmsLoading] = useState(false)
  const [smsDraft, setSmsDraft] = useState('')
  const smsListRef = useRef<HTMLDivElement>(null)

  const threadKey = normalize(firstDefined(record, ['thread_key', 'threadKey', 'conversation_id', 'conversationId']))

  // Load SMS messages when flipped
  useEffect(() => {
    if (!isSmsFlipped || variant !== 'selected') return
    // Prefer passed-in messages when available
    if (messages.length > 0) {
      setSmsMessages(messages)
      return
    }
    if (!threadKey) return
    let cancelled = false
    setSmsLoading(true)
    getThreadMessages(threadKey)
      .then((msgs) => { if (!cancelled) { setSmsMessages(msgs); setSmsLoading(false) } })
      .catch(() => { if (!cancelled) { setSmsLoading(false) } })
    return () => { cancelled = true }
  }, [isSmsFlipped, threadKey, variant, messages])

  // Auto-scroll SMS list to bottom
  useEffect(() => {
    if (isSmsFlipped && smsListRef.current) {
      smsListRef.current.scrollTop = smsListRef.current.scrollHeight
    }
  }, [smsMessages, isSmsFlipped])

  // Escape: flip back or close
  useEffect(() => {
    if (variant !== 'selected') return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isSmsFlipped) {
          setIsSmsFlipped(false)
        } else {
          onClose?.()
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [variant, isSmsFlipped, onClose])

  const densityMode = variant === 'hover' ? 'compact' : resolveDensityMode(layoutMode)
  const sellerName = normalize(firstDefined(record, [
    'seller_display_name',
    'sellerDisplayName',
    'owner_display_name',
    'ownerDisplayName',
    'owner_full_name',
    'owner_name',
    'ownerName',
    'entity_name',
    'entityName',
    'seller_name',
    'sellerName',
    'display_name',
    'displayName',
    'prospect_name',
    'contact_name',
  ])) || 'Unknown Seller'
  const address = normalize(firstDefined(record, [
    'property_address_full',
    'propertyAddressFull',
    'property_address',
    'propertyAddress',
    'address',
    'situs_address',
  ])) || 'Property Unknown'
  const ownerType = deriveOwnerType(record)
  const propertyType = titleize(normalize(firstDefined(record, ['property_type', 'propertyType', 'property_class', 'propertyClass'])) || '—')

  const { streetViewImage, mapImage, satelliteImage } = getNormalizedPropertyImages(record)
  const imageSequence = [streetViewImage, satelliteImage, mapImage]
    .filter(Boolean)
    .map(url => url!.replace(/^http:\/\//i, 'https://'))

  const currentImageUrl = imageSequence[0] || null

  useEffect(() => {
    if (import.meta.env.DEV && imageSequence.length === 0) {
      console.warn("[map-image-missing]", address, record)
    }
  }, [address, record, imageSequence.length])

  const pills = deriveSellerStatusPills(record, messages)
  const physicalSummary = buildCompactPhysicalSummary(record)
  const financialMetrics: MetricItem[] = [
    { label: 'Value', value: formatMoney(firstDefined(record, ['estimated_value', 'estimatedValue'])) },
    { label: 'Equity', value: formatPercent(firstDefined(record, ['equity_percent', 'equityPercent'])) },
    { label: 'Repairs', value: formatMoney(firstDefined(record, ['estimated_repair_cost', 'estimatedRepairCost', 'repair_estimate'])) },
  ]
  const motivationScore = asNumber(firstDefined(record, ['motivation_score', 'motivationScore', 'final_acquisition_score', 'finalAcquisitionScore', 'priority_score', 'priorityScore']))
  const motivationTier = deriveMotivationTier(motivationScore)
  const scoreWidth = motivationScore === null ? 0 : Math.max(2, Math.min(100, motivationScore))
  const ownershipMeta = buildOwnershipMeta(record)
  const allTags = getTopPropertyTags(record)
  const tagLimit = densityMode === 'compact' ? 4 : densityMode === 'balanced' ? 5 : densityMode === 'expanded' ? 6 : 8
  const visibleTags = allTags.slice(0, tagLimit)
  const hiddenTagCount = Math.max(0, allTags.length - visibleTags.length)
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const derivedMessage = normalize(firstDefined(record, ['last_outreach_message', 'latest_message_body', 'latestMessageBody', 'last_message', 'lastMessageBody', 'preview']))
  const messageBody = latestMessage?.body || derivedMessage || 'No message found'
  const messageTime = latestMessage?.createdAt || latestMessage?.timelineAt || firstDefined(record, ['last_reply_at', 'lastReplyAt', 'last_outbound_at', 'lastOutboundAt', 'last_activity_at', 'lastActivityAt'])
  const messageDirection = latestMessage?.direction || lower(firstDefined(record, ['latest_message_direction', 'last_message_direction']))
  const messageLabel = messageDirection === 'inbound' || hasReply(record, messages) ? 'Last Reply' : 'Last Outreach'
  const statusItems = buildCompactStatusItems(record, messages)
  const canShowPropertyTypeBadge = variant === 'selected' || densityMode !== 'compact'

  const imgHtml = currentImageUrl ? `<img
    src="${currentImageUrl}"
    alt="${address.replace(/"/g, '&quot;')}"
    loading="lazy"
    style="object-fit: cover; width: 100%; height: 100%; border-radius: 8px"
    onerror="
      var seq = [${imageSequence.map(s => `'${s}'`).join(',')}];
      var idx = parseInt(this.getAttribute('data-err') || '0') + 1;
      this.setAttribute('data-err', idx);
      if (idx < seq.length) {
        this.src = seq[idx];
      } else {
        this.parentElement.style.display = 'none';
        var placeholder = this.parentElement.nextElementSibling;
        if (placeholder && placeholder.className.indexOf('nx-seller-card__image-placeholder') > -1) {
          placeholder.style.display = 'flex';
        }
      }
    "
  />` : ''

  // ── Front face content (card + deal summary) ──────────────────────────────
  const frontFace = (
    <>
      <div className="nx-seller-card__image" style={{ minHeight: '140px' }}>
        {currentImageUrl && (
          <div dangerouslySetInnerHTML={{ __html: imgHtml }} style={{ width: '100%', height: '100%', display: 'flex' }} />
        )}
        <div
          className="nx-seller-card__image-placeholder"
          style={{
            display: currentImageUrl ? 'none' : 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '140px',
            backgroundColor: '#111',
            borderRadius: '8px',
            color: '#666',
            width: '100%',
            height: '100%',
          }}
        >
          Street View Preview
        </div>
        <div className="nx-seller-card__image-overlay" />
        <div className="nx-seller-card__image-label">Street View</div>
        {variant === 'selected' && onClose ? (
          <button type="button" className="nx-seller-card__close" onClick={onClose} aria-label="Close seller card">×</button>
        ) : null}
      </div>

      <div className="nx-seller-card__body">
        <header className="nx-seller-card__identity">
          <div className="nx-seller-card__identity-copy">
            <h3>{sellerName}</h3>
            <p title={address}>{address}</p>
          </div>
          <div className="nx-seller-card__identity-badges">
            <span className="nx-seller-card__badge">{ownerType}</span>
            {canShowPropertyTypeBadge ? <span className="nx-seller-card__badge is-muted">{propertyType}</span> : null}
          </div>
        </header>

        <section className="nx-seller-card__summary">
          <p>{physicalSummary.join(' · ') || 'Needs Review'}</p>
        </section>

        <section className="nx-seller-card__financial-row" aria-label="Financial summary">
          {financialMetrics.map((item) => (
            <div key={item.label} className={cls('nx-seller-card__financial-item', item.label === 'Value' && 'is-primary')}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </section>

        <section className="nx-seller-card__intel-strip">
          <div className="nx-seller-card__intel-score-head">
            <strong>{motivationScore === null ? 'Motivation Needs Data' : `Motivation ${Math.round(motivationScore)}/100`}</strong>
            <small>{motivationTier === 'Needs Data' ? 'Needs Data' : motivationTier}</small>
          </div>
          <div className="nx-seller-card__progress is-thin">
            <span className="nx-seller-card__progress-fill" style={{ width: `${scoreWidth}%` }} />
          </div>
          <div className="nx-seller-card__micro-meta">
            {ownershipMeta.length > 0 ? ownershipMeta.join(' · ') : 'No ownership history available'}
          </div>
        </section>

        {visibleTags.length > 0 ? (
          <section className="nx-seller-card__tags">
            {visibleTags.map((tag) => <span key={tag} className="nx-seller-card__tag">{tag}</span>)}
            {hiddenTagCount > 0 ? <span className="nx-seller-card__tag is-more">+{hiddenTagCount}</span> : null}
          </section>
        ) : null}

        <section className="nx-seller-card__message-strip">
          <div className="nx-seller-card__status-strip">
            {statusItems.length > 0 ? statusItems.map((label) => <StatusPill key={label} pill={pills.find((pill) => pill.label === label) ?? { label, tone: 'neutral' }} />) : null}
          </div>
          <div className="nx-seller-card__message-head">
            <strong>{messageLabel}</strong>
            <small>{formatRelativeTime(messageTime) || '—'}</small>
          </div>
          <p className="nx-seller-card__message-copy">{messageBody}</p>
        </section>

        {/* ── Action row — updated with SMS flip + Deal Intel ── */}
        <section className="nx-seller-card__actions-row">
          {variant === 'selected' && onOpenDealIntelligence ? (
            <button
              type="button"
              className="nx-mic-btn nx-mic-btn--primary"
              onClick={onOpenDealIntelligence}
              title="Open full Deal Intelligence"
            >
              Deal Intel
            </button>
          ) : null}
          {variant === 'selected' ? (
            <button
              type="button"
              className="nx-mic-btn nx-mic-btn--violet"
              onClick={() => setIsSmsFlipped(true)}
              title="Open SMS conversation"
            >
              SMS
            </button>
          ) : null}
          {variant === 'selected' && onOpenConversation ? (
            <button
              type="button"
              className="nx-mic-btn"
              onClick={onOpenConversation}
              title="Open full conversation"
            >
              Open
            </button>
          ) : null}
          <button
            type="button"
            className="nx-mic-btn"
            disabled
            title="Follow-Up scheduling coming soon"
          >
            Follow-Up
          </button>
        </section>

        {variant === 'selected' ? (
          <section className="nx-seller-card__panel nx-seller-card__actions-panel">
            {(onDraftChange && onSend) ? (
              <form
                className="nx-seller-card__composer"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault()
                  if (!draftText.trim() || disabled) return
                  onSend()
                }}
              >
                <input
                  value={draftText}
                  onChange={(event) => onDraftChange(event.target.value)}
                  placeholder={disabled ? 'Messaging disabled' : 'Quick reply to seller…'}
                  disabled={disabled}
                />
                <button type="submit" disabled={!draftText.trim() || disabled}>Send</button>
              </form>
            ) : null}
            {loading ? <div className="nx-seller-card__loading">Syncing conversation…</div> : null}
          </section>
        ) : null}
      </div>
    </>
  )

  // ── Back face: SMS conversation view ─────────────────────────────────────
  const displayMessages = smsMessages.length > 0 ? smsMessages : messages
  const sentCount = normalize(firstDefined(record, ['sent_count']))
  const latestMsgAt = normalize(firstDefined(record, ['latest_message_at', 'last_activity_at']))

  const backFace = variant === 'selected' ? (
    <div className="nx-seller-card__sms-view">
      {/* SMS header */}
      <div className="nx-seller-card__sms-head">
        <div className="nx-seller-card__sms-head-identity">
          <div className="nx-seller-card__sms-name">{sellerName}</div>
          <div className="nx-seller-card__sms-addr">{address}</div>
          <div className="nx-seller-card__sms-status">
            {sentCount ? `${sentCount} sent` : 'Conversation'}
            {latestMsgAt ? ` · ${formatRelativeTime(latestMsgAt)}` : ''}
          </div>
        </div>
        <div className="nx-seller-card__sms-head-actions">
          <button
            type="button"
            className="nx-mic-btn nx-mic-btn--sm"
            onClick={() => setIsSmsFlipped(false)}
            title="Back to deal summary"
          >
            ← Back
          </button>
          {onClose ? (
            <button
              type="button"
              className="nx-mic-btn nx-mic-btn--sm"
              onClick={onClose}
              aria-label="Close card"
            >
              ×
            </button>
          ) : null}
        </div>
      </div>

      {/* Message list */}
      <div ref={smsListRef} className="nx-seller-card__sms-messages">
        {smsLoading && (
          <div className="nx-seller-card__sms-empty">Loading conversation…</div>
        )}
        {!smsLoading && displayMessages.length === 0 && (
          <div className="nx-seller-card__sms-empty">
            {threadKey ? 'No messages found.' : 'No thread key — open full inbox to view this conversation.'}
          </div>
        )}
        {displayMessages.slice(-40).map((msg) => {
          const isOut = msg.direction === 'outbound'
          const timeStr = smsFmtTime(msg.createdAt || msg.timelineAt)
          const delivClass = msg.deliveryStatus ? smsDeliveryClass(msg.deliveryStatus) : ''
          return (
            <div
              key={msg.id}
              className={cls('nx-seller-card__sms-msg', isOut ? 'nx-seller-card__sms-msg--out' : 'nx-seller-card__sms-msg--in')}
            >
              <div className="nx-seller-card__sms-bubble">
                {msg.body || <em style={{ opacity: 0.5 }}>No content</em>}
              </div>
              {(timeStr || msg.deliveryStatus) ? (
                <div className="nx-seller-card__sms-meta">
                  {timeStr ? <span>{timeStr}</span> : null}
                  {isOut && msg.deliveryStatus ? (
                    <span className={delivClass}>{msg.deliveryStatus}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* Compose area */}
      <div className="nx-seller-card__sms-compose">
        <div className="nx-seller-card__sms-input-row">
          <textarea
            className="nx-seller-card__sms-input"
            value={smsDraft}
            onChange={(e) => setSmsDraft(e.target.value)}
            placeholder={disabled ? 'Messaging not available here' : 'Type a message…'}
            disabled={disabled}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && smsDraft.trim() && !disabled) {
                e.preventDefault()
                onSend?.()
                setSmsDraft('')
              }
            }}
          />
          <button
            type="button"
            className="nx-mic-btn nx-mic-btn--primary"
            disabled={!smsDraft.trim() || disabled}
            onClick={() => {
              if (!smsDraft.trim() || disabled) return
              onSend?.()
              setSmsDraft('')
            }}
          >
            Send
          </button>
        </div>
        <div className="nx-seller-card__sms-compose-btns">
          {onOpenConversation ? (
            <button type="button" className="nx-mic-btn nx-mic-btn--sm" onClick={onOpenConversation}>
              Open Full Inbox
            </button>
          ) : null}
          <button type="button" className="nx-mic-btn nx-mic-btn--sm" disabled title="Templates coming soon">
            Templates
          </button>
          <button type="button" className="nx-mic-btn nx-mic-btn--sm" disabled title="AI Draft coming soon">
            AI Draft
          </button>
          <button
            type="button"
            className="nx-mic-btn nx-mic-btn--sm"
            onClick={() => setIsSmsFlipped(false)}
          >
            ← Back
          </button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <article className={cls('nx-seller-card', `is-${variant}`, `seller-card--${densityMode}`)}>
      <div className={cls('nx-seller-card__scene', isSmsFlipped && 'is-flipped')}>
        <div className="nx-seller-card__face--front">
          {frontFace}
        </div>
        {variant === 'selected' && (
          <div className="nx-seller-card__face--back">
            {backFace}
          </div>
        )}
      </div>
    </article>
  )
}
