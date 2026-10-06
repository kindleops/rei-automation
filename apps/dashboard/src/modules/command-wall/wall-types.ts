/** Command Wall — wire types for /api/wall/* (see apps/api/src/lib/domain/command-wall). */

export type WallPresetId =
  | 'national_command'
  | 'acquisition_pulse'
  | 'campaign_operations'
  | 'market_intelligence'
  | 'spatial_intelligence'
  | 'custom'

export type WallThemeId = 'dark' | 'true_black' | 'light' | 'red_ops'
export type WallPrivacyMode = 'operations' | 'privacy' | 'public_safe'
export type WallOledLevel = 'off' | 'low' | 'high'
export type WallCameraMode = 'static' | 'active_market' | 'tour' | 'event_follow'
export type WallRenderMode = 'full' | 'lite' | 'safe'
export type WallLayerId = 'campaigns' | 'activity' | 'pipeline' | 'sales' | 'investor' | 'mi_heat' | 'cameras' | 'crime' | 'boundaries'

export interface WallRotationStep { preset: WallPresetId; minutes: number }

export interface WallDisplayConfig {
  preset: WallPresetId
  theme: WallThemeId
  privacy_mode: WallPrivacyMode
  oled_protection: WallOledLevel
  camera_mode: WallCameraMode
  audio: 'off' | 'critical' | 'high_value' | 'all_selected'
  show_feed: boolean
  overnight_low_light: boolean
  rotation: { enabled: boolean; steps: WallRotationStep[] }
  layers: WallLayerId[] | null
  watched_markets: string[]
  map_view: { lng: number; lat: number; zoom: number } | null
}

export interface WallViewCommand {
  id: string
  preset: WallPresetId | null
  market: string | null
  campaign_id: string | null
  hold_minutes: number
  issued_at: string
  expires_at: string
}

export interface WallSession {
  id: string
  name: string
  config: WallDisplayConfig
  config_version: number
  view_command: WallViewCommand | null
  token_expires_at: string | null
}

export interface WallGeo {
  market_id?: string | null
  market_name?: string | null
  zip?: string | null
  lat: number | null
  lng: number | null
  precision: 'property' | 'zip' | 'grid' | 'market' | 'none'
}

export type WallEventKind = 'reply' | 'interest' | 'asking_price' | 'offer' | 'counter' | 'deal' | 'stage' | 'campaign' | 'signal' | 'sends' | 'opt_out'

export interface WallEvent {
  id: string
  seq: number
  kind: WallEventKind
  priority: 0 | 1 | 2 | 3
  tone: 'cyan' | 'green' | 'gold' | 'violet' | 'red' | 'neutral'
  label: string
  occurred_at: string
  count: number
  window_ms: number | null
  geo: WallGeo | null
  intent?: string | null
  campaign?: { id: string } | null
  amount?: number
  signal?: { rule_key?: string; severity: string } | null
}

export interface WallFeedStatus {
  state: 'live' | 'degraded' | 'starting'
  last_ok_at: string | null
  stale_ms: number | null
  projector_lag_ms: number | null
  tick_ms: number
}

export interface WallEventsReply {
  ok: true
  epoch: string
  reset: boolean
  head: number
  events: WallEvent[]
  status: WallFeedStatus
  config_version: number
  server_time: string
}

export type WallPart<T> = ({ status: 'ok' | 'stale'; as_of: string } & T) | { status: 'unavailable'; as_of: null; error?: string }

export interface WallMetrics { window_start: string; sent: number; delivered: number; failed: number; replies: number; positive: number; opt_outs: number; queue_waiting: number }
export interface WallQueue { state: 'idle' | 'healthy' | 'attention' | 'delayed'; waiting: number; lagging: number; failed_today: number; latest_sent_at: string | null }
export interface WallFleet { total: number; online: number; cooling: number; flagged: number; paused: number; daily_capacity: number | null; used_today: number | null }

export interface WallCampaign {
  id: string
  name: string | null
  market_id: string | null
  market_name: string | null
  status: string
  sent?: number
  queued?: number
  replied?: number
  positive?: number
  progress_pct: number | null
  synced_at?: string | null
}

export interface WallSignal { id: string; rule_key?: string; severity: string; label: string; subject_type?: string | null; fired_at: string; open?: number }
export interface WallMarket { id: string; name: string; state: string | null; lat: number | null; lng: number | null }

export interface WallMiZip {
  id: string
  zip: string
  lat: number | null
  lng: number | null
  sales: number | null
  median_price: number | null
  median_ppsf: number | null
  investor_recorded_share: number | null
  investor_recorded_n: number | null
  investor_recorded_count: number | null
  investor_inferred_share: number | null
  entity_owned_count: number | null
  sales_growth: number | null
}
export interface WallMiMarket { id: string; status: 'ok' | 'unavailable'; label?: string; window?: { label?: string; start?: string; end?: string } | null; top_zips?: WallMiZip[] }
export interface WallMi { status: 'ok' | 'unavailable'; as_of?: string; markets: WallMiMarket[]; inferred_available?: boolean; reason?: string }

export interface WallSystem { level: 'healthy' | 'attention' | 'degraded' | 'critical'; parts: { key: string; label: string; level: string }[] }

export interface WallState {
  ok: true
  generated_at: string
  privacy_mode: WallPrivacyMode
  metrics: WallPart<WallMetrics>
  queue: WallPart<WallQueue>
  fleet: WallPart<WallFleet>
  offers: WallPart<{ today: number }>
  system: WallSystem
  campaigns: WallCampaign[]
  campaigns_status: string
  signals: WallSignal[]
  signals_status: string
  markets: WallMarket[]
  mi: WallMi | null
}

export type WallConnection = 'connecting' | 'live' | 'reconnecting' | 'offline'
